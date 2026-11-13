import type { PoolClient } from 'pg'
import { config } from '../config.js'
import { db } from '../db.js'
import { IntegrationError } from './1688.js'
import { isQwenModel, QWEN_MODELS, type QwenModel } from '../llm/qwen.js'
import { IMAGE_MODELS, type ImageModelId } from '../llm/apimart-image.js'

/**
 * Teams: a top-level account (opened by the super administrator) and the sub-accounts it opened. The super administrator
 * chooses each team's text and image model and gives it credits; listing a collected product on 1688 costs
 * CREDITS_PER_LISTING. The super administrator's own team is not limited and sets the defaults for background work that
 * belongs to no one in particular.
 */
export const CREDITS_PER_LISTING = 10
export const DEFAULT_IMAGE_MODEL: ImageModelId = 'gpt-image-2.5-flare'
export const TEXT_MODEL_CHOICES = QWEN_MODELS
export const IMAGE_MODEL_CHOICES = IMAGE_MODELS
type Queryable = Pick<PoolClient, 'query'>
export type Team = { ownerId: string; ownerName: string; unlimited: boolean; textModel: QwenModel; imageModel: ImageModelId; credits: number }

const textModel = (value: unknown): QwenModel => typeof value === 'string' && isQwenModel(value) ? value : config.QWEN_DEFAULT_MODEL
const imageModel = (value: unknown): ImageModelId => (IMAGE_MODELS as readonly string[]).includes(String(value)) ? value as ImageModelId : DEFAULT_IMAGE_MODEL

async function teamByOwner(tenantId: string, ownerId: string, client: Queryable = db): Promise<Team> {
  const row = (await client.query(`SELECT u.id,u.display_name,EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.code='super_admin') AS unlimited,
      s.text_model,s.image_model,coalesce(s.credits,0) AS credits
    FROM users u LEFT JOIN team_ai_settings s ON s.owner_user_id=u.id WHERE u.id=$1 AND u.tenant_id=$2`, [ownerId, tenantId])).rows[0]
  if (!row) throw new IntegrationError('TEAM_NOT_FOUND', '找不到该账号所属的团队。', 404)
  return { ownerId: row.id, ownerName: row.display_name, unlimited: row.unlimited, textModel: textModel(row.text_model), imageModel: imageModel(row.image_model), credits: Number(row.credits) }
}

/** The team an account belongs to: its own if it is top-level, else the team of the account that opened it. */
export async function teamOf(tenantId: string, userId: string, client: Queryable = db): Promise<Team> {
  const row = (await client.query('SELECT coalesce(parent_user_id,id) AS owner FROM users WHERE id=$1 AND tenant_id=$2', [userId, tenantId])).rows[0]
  if (!row) throw new IntegrationError('TEAM_NOT_FOUND', '找不到该账号所属的团队。', 404)
  return teamByOwner(tenantId, row.owner, client)
}

/** Models for work started by no one in particular (scheduled reviews): the super administrator's team. */
export async function defaultTeam(tenantId: string): Promise<Pick<Team, 'textModel' | 'imageModel'>> {
  const owner = (await db.query(`SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
    WHERE u.tenant_id=$1 AND r.code='super_admin' AND u.deleted_at IS NULL ORDER BY u.created_at LIMIT 1`, [tenantId])).rows[0]
  return owner ? teamByOwner(tenantId, owner.id) : { textModel: config.QWEN_DEFAULT_MODEL, imageModel: DEFAULT_IMAGE_MODEL }
}

const insufficient = (credits: number) => new IntegrationError('CREDITS_INSUFFICIENT', `团队积分不足：采集商品上架每件需 ${CREDITS_PER_LISTING} 积分，当前剩余 ${credits}。请联系超级管理员调整额度。`, 402)

/** Checked before any paid work (AI pictures) starts for a collected product. */
export async function requireListingCredits(tenantId: string, userId: string) {
  const team = await teamOf(tenantId, userId)
  if (!team.unlimited && team.credits < CREDITS_PER_LISTING) throw insufficient(team.credits)
  return team
}

async function ledger(client: Queryable, tenantId: string, ownerId: string, delta: number, balance: number, reason: 'adjust' | 'publish' | 'refund', actorId: string | null, refId: string | null, note: string | null) {
  await client.query('INSERT INTO team_credit_ledger(tenant_id,owner_user_id,delta,balance_after,reason,note,ref_id,actor_id)VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [tenantId, ownerId, delta, balance, reason, note, refId, actorId])
}

/**
 * Takes the listing's credits before the platform call, inside the caller's transaction (a shortage rolls the claim back).
 * Returns the team charged, or null when nothing was taken (unlimited team, or not a collected product).
 */
export async function chargeListing(client: Queryable, tenantId: string, userId: string, productId: string, draftId: string) {
  const collected = (await client.query('SELECT 1 FROM collected_products WHERE tenant_id=$1 AND product_id=$2 LIMIT 1', [tenantId, productId])).rows.length > 0
  if (!collected) return null
  const team = await teamOf(tenantId, userId, client)
  if (team.unlimited) return null
  const row = (await client.query('UPDATE team_ai_settings SET credits=credits-$2,updated_at=now() WHERE owner_user_id=$1 AND credits>=$2 RETURNING credits', [team.ownerId, CREDITS_PER_LISTING])).rows[0]
  if (!row) throw insufficient(team.credits)
  await ledger(client, tenantId, team.ownerId, -CREDITS_PER_LISTING, row.credits, 'publish', userId, draftId, null)
  return team.ownerId
}

/** Gives the credits back when the platform definitely refused the listing. */
export async function refundListing(tenantId: string, ownerId: string, actorId: string, draftId: string) {
  const row = (await db.query('UPDATE team_ai_settings SET credits=credits+$2,updated_at=now() WHERE owner_user_id=$1 RETURNING credits', [ownerId, CREDITS_PER_LISTING])).rows[0]
  if (row) await ledger(db, tenantId, ownerId, CREDITS_PER_LISTING, row.credits, 'refund', actorId, draftId, '平台拒绝发布，退回积分')
}

/** The super administrator's changes to a team: models and/or a credit adjustment (never below zero). */
export async function updateTeam(tenantId: string, ownerId: string, actorId: string, input: { textModel?: string; imageModel?: string; delta?: number; note?: string }) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const owner = (await client.query('SELECT id FROM users WHERE id=$1 AND tenant_id=$2 AND parent_user_id IS NULL AND deleted_at IS NULL', [ownerId, tenantId])).rows[0]
    if (!owner) throw new IntegrationError('TEAM_NOT_FOUND', '团队不存在。', 404)
    await client.query('INSERT INTO team_ai_settings(owner_user_id,tenant_id,updated_by) VALUES($1,$2,$3) ON CONFLICT(owner_user_id) DO NOTHING', [ownerId, tenantId, actorId])
    const current = (await client.query('SELECT credits FROM team_ai_settings WHERE owner_user_id=$1 FOR UPDATE', [ownerId])).rows[0]
    const credits = Number(current.credits) + (input.delta ?? 0)
    if (credits < 0) throw new IntegrationError('CREDITS_NEGATIVE', `扣减后积分不能小于 0（当前 ${current.credits}）。`, 400)
    await client.query(`UPDATE team_ai_settings SET text_model=CASE WHEN $2::text IS NULL THEN text_model ELSE $2 END,image_model=CASE WHEN $3::text IS NULL THEN image_model ELSE $3 END,
      credits=$4,updated_by=$5,updated_at=now() WHERE owner_user_id=$1`, [ownerId, input.textModel ?? null, input.imageModel ?? null, credits, actorId])
    if (input.delta) await ledger(client, tenantId, ownerId, input.delta, credits, 'adjust', actorId, null, input.note?.trim() || null)
    await client.query("INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data)VALUES($1,$2,'team.ai.update','user',$3,$4)", [tenantId, actorId, ownerId, JSON.stringify(input)])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  return teamByOwner(tenantId, ownerId)
}

/** Every team for the super administrator's page: owner, members, models, credits and recent movements. */
export async function listTeams(tenantId: string) {
  const rows = (await db.query(`SELECT u.id,u.display_name,u.email::text,u.status,
      EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.code='super_admin') AS unlimited,
      (SELECT count(*)::int FROM users m WHERE m.parent_user_id=u.id AND m.deleted_at IS NULL) AS members,
      s.text_model,s.image_model,coalesce(s.credits,0) AS credits,
      coalesce((SELECT json_agg(l ORDER BY l.created_at DESC) FROM (SELECT delta,balance_after,reason,note,created_at FROM team_credit_ledger WHERE owner_user_id=u.id ORDER BY created_at DESC LIMIT 5) l),'[]') AS ledger
    FROM users u LEFT JOIN team_ai_settings s ON s.owner_user_id=u.id
    WHERE u.tenant_id=$1 AND u.parent_user_id IS NULL AND u.deleted_at IS NULL ORDER BY 5 DESC,u.created_at`, [tenantId])).rows
  return rows.map(r => ({ ownerId: r.id, name: r.display_name, email: r.email, status: r.status, unlimited: r.unlimited, members: r.members, textModel: textModel(r.text_model), imageModel: imageModel(r.image_model), credits: Number(r.credits), ledger: r.ledger }))
}
