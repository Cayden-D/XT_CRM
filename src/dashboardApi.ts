import { request } from './api'

export type DashboardRange = 'today'|'7d'|'30d'
export type PeriodTotals = { paidAmount:number; paidOrders:number; paidBuyers:number; refundAmount:number; refunds:number; netAmount:number; reception:number; inquired:number; converted:number; conversionRate:number|null }
export type DashboardAgent = { agentId:string; loginId:string; isMain:boolean; userName:string|null; reception:number; inquiry:number; paidBuyers:number; paidAmount:number; firstResponseSeconds:number|null; unanswered:number }
export type Dashboard = {
  range:DashboardRange; period:{from:string;to:string}; previous:{from:string;to:string}
  shops:{id:string;display_name:string|null;status:string}[]; connectionId:string|null
  sections:{performance:boolean;customers:boolean;listings:boolean}
  kpis?:{current:PeriodTotals;previous:PeriodTotals}
  trend?:{date:string;paid_amount:number;paid_orders:number;reception:number}[]
  service?:{scheme:string;firstResponseSeconds:number|null;unanswered:number;offsiteRisks:number;keywordAlerts:number;agents:DashboardAgent[]}
  buyerMix?:{first_time:number;returning:number}
  sync?:{backfill_from:string|null;orders_synced_from:string|null;refunds_synced_from:string|null;chats_synced_from:string|null;last_success:string|null;last_run:{status:string;errorCode:string|null;at:string}|null;pending_sessions:number;history_days:number}
  customers?:{total:number;due:number;due_overdue:number;unpaid:number;unpaid_amount:number;recent_no_order:number;buyers:number;repeat_buyers:number;overdue:number}
  listings?:{queue:Record<string,number>;blockedReasons:{reason:string;n:number}[];drafts:number;listings:Record<string,number>;collected:number}
}

export function getDashboard(range:DashboardRange, connectionId?:string) {
  const params = new URLSearchParams({ range })
  if (connectionId) params.set('connectionId', connectionId)
  return request<{data:Dashboard}>(`/api/dashboard?${params}`)
}
