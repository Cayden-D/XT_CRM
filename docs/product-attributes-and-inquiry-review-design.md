# 产品详细属性与询盘复盘：可行性分析与功能设计

> 日期：2026-11-05　状态：P1–P4 主体已开发并合入 main，未部署生产；待甲方确认的问题见第 9 节，实施情况见第 10 节。
> 依据：现有代码、已有迁移，以及本地库 `ai_crm` 的只读聚合统计。本地同步数据截至 2026-10-20，**生产库比例可能不同**，P0 需在生产环境复核。

## 1. 结论摘要

| 需求 | 结论 | 一句话说明 |
| --- | --- | --- |
| 1. 产品详细属性（长宽高、重量、箱规、特性、自定义） | **完全可行** | 属性可全部维护在 CRM。净重/尺寸和销售包装件重尺可自动带入发布草稿；**箱规本期只存 CRM，不提交平台**。 |
| 2. 询盘 × 客服 × 产品分析 | **部分可行，需要调整预期** | 能分析“客服怎么说、响应如何、结果如何”；**看不到买家原话**，所以“流失原因”和“产品熟悉度”只能是带证据的推断，要由主管确认，不能当事实或工资依据。 |

向甲方说明需求 2 时，以下五点最关键：

1. **买家消息内容被平台脱敏**，接口只给长度、类型和关键词命中。这是平台限制，CRM 改不了。
2. **客服文字很短。** 每会话客服文字中位数只有 34 字（P90 为 76 字），48% 的文字消息来自重复话术，另有 34% 的客服消息是无内容的“其他消息”。
3. **流失会话大多关联不到商品。** 目前只有约 2.4% 的有文字会话发过商品链接。此前同步还把链接里的商品 ID 遮盖掉了（63 条全部被遮盖），新同步的消息已修复。
4. **按业务员分析的前提目前不成立。** 近一个月 98% 的会话落在主账号上（6,205 / 6,314），11 个客服账号都没有绑定系统用户。如果多人共用主账号，就分不清是谁聊的。
5. **关键词命中是唯一合规的买家内容信号，但不追溯历史，晚开一天就少一天数据。** 建议甲方确认后尽早配置，不必等开发。

**AI 成本不是约束**（估算每月几元到几十元），约束是证据质量。

## 2. 现状与差距

### 2.1 产品属性

| 环节 | 现状 | 差距 |
| --- | --- | --- |
| 产品资料 | `products.specifications` 是“字符串 → 字符串”的 JSONB；抽屉里用文本框按“名称: 内容”逐行编辑（`src/ProductsPage.tsx`） | 没有类型、单位、分组；无法校验长宽高或重量 |
| 文本解析 | 只按半角冒号切分 | **现存缺陷：** 写成“重量：1kg”（全角冒号）的行，保存时会被静默丢弃 |
| SKU | `product_variants` 只有 `attributes/unit_price/stock` 等 | 没有按规格区分的重量和尺寸 |
| 采集 | `collected_products.attributes` 转正式产品时写入 `specifications`；原始数据保留在采集表 | 22 条采集记录里包装类信息很少，**没有箱规** |
| 草稿类目属性 | `createDraftFromProduct` 和 `routes/1688-agent.ts:89` 都通过 `collectedCategoryDefaults` 预填，**只读采集表**，且要求来源类目与目标类目相同 | 手工维护的属性不会被规则预填；换类目也不预填 |
| Agent | 把 `specifications` 作为事实发给模型（`1688-agent.ts:100,112`） | 只有走 Agent 才会用到，且结果依赖模型 |
| 件重尺 | `officialLogistics` 只来自公共发布模板（全店一个值）或人工填写，校验在 `shared/1688-logistics.ts` | 商品资料中没有这份数据；抽样草稿的重量是模板值，尺寸为 0 |
| 按规格件重尺 | 校验已支持 `showLogisticsCategory='sku'`，编辑器只支持按商品（`src/1688Page.tsx:144`） | 缺按规格的界面 |

本地抽样（13 份草稿的平台规则，均为现有类目）：

- `officialLogistics.logisticsRequired=true`：**13 份全部要求件重尺**，所以把它自动带入有直接价值。
- `showBoxSpec / boxSpecRequired / cartonSpecRequired` 全部为 `false`：字段存在，但这些类目不展示也不要求箱规，**平台的箱规提交结构也没有样例可核实**。
- 类目属性里能对应的只有 `净重`、`重量`、`尺寸`、`外形尺寸`、`单件净重`，都是文本输入；没有箱规类属性。
- 在售商品快照 `integration_1688_listings.snapshot` 已有 `attributes`（平均 33 项，其中“尺寸”出现在 40/80 个商品上，“净重”在 28/80 个商品上）和 `shippingInfo.unitWeight`（57/80，单位待核实）。**这是现成的回填来源，不需要新调用接口。**

规模差距：本地只有 **13 个产品资料、83 条在售缓存，其中只有 3 条绑定了产品**；而订单中出现过 **441 个不同商品**。

### 2.2 询盘、客服、产品

| 数据 | 实际能拿到什么 | 本地实测 |
| --- | --- | --- |
| 买家消息 | 仅 `length`、类型、关键词命中；内容为脱敏占位，不入库 | 36,006 条；“其他消息”4,398 条，长度为 0 |
| 客服文字 | `text_masked`：遮盖手机/微信/QQ/6 位以上数字，最长 500 字，**保留 90 天** | 2026-10-10 起才开始采集；10-12 之后“正常消息”采集率 100%，其中约 91% 有实际文字 |
| 客服“其他消息” | 正文为空（图片、商品卡片或机器人，无法区分） | 15,466 / 45,043 = **34%** |
| 自动回复 | 文档有该类型，但实测只出现正常/其他/系统消息，话术混在“正常消息”里 | 一条固定话术重复 1,243 次；近 45 天 48% 的文字消息来自重复 ≥5 次的文本 |
| 文字长度 | — | ≤3 字 27%，4–10 字 47%，11–20 字 10%，21–50 字 16%，>50 字 1% |
| 关键词命中 | 平台在发送时打标，**不追溯**；买家消息也能命中 | 仅 20 条（退款、退货、换货、漏发、破损、少发）；本地词库表为空 |
| 客服身份 | `selfLoginId` 可判定归属账号 | 主账号占 98%；11 个账号的 `user_id` 全为空 |
| 订单商品 | `perf_orders.items` 含 `productId/name/sku` | 8,134 单全有，92% 为单品订单 |
| 订单归属 | `perf_order_attributions` 含 `session_id`，多方案 | 可靠，已用于工资 |
| 退款原因 | `perf_refunds.apply_reason` 是**买家自选的真实原因** | 不想买了 471、无理由退货 169、协商一致 110、物流未到 15、质量问题 11 等 |
| 取消订单 | 状态 `cancel` 993 单；未保存取消原因 | `closeReason` 类字段是否返回待抽样 |

**会话到商品的关联，目前不存在：**

- 消息没有商品字段；同步时也不保留原始响应，接口是否还有其他字段需抽样确认。
- `analyzeAgentText` 的 `mask()` 作用于含链接的全文，`/[0-9]{6,}/` 把 `detail.1688.com/offer/<id>` 的 ID 遮盖了。实测 63 条商品链接全部变成 `offer/######`。**已修复（迁移 044）：** 遮盖前把 ID 提取到 `linked_offer_ids`，存储文本仍保持遮盖；旧消息只有重新读取且平台仍返回内容时才能补回。
- 商品链接出现在 51 个会话中，占有文字会话（2,136 个）的 2.4%。

**流失的现有口径（`factsSql`）：** 非售后的询盘，在归属窗口（默认 72 小时）内没有订单，记为 `no_order`。按此口径近似统计（固定 4 天窗口、买家·日，2026-09-17 至 10-17）：

| 买家·日 | 售后 | 询盘 | 未下单 | 其中无人工回复 | 下单未付款 | 已付款 |
| --- | --- | --- | --- | --- | --- | --- |
| 5,478 | 1,854 | 3,624 | **2,998（83%）** | 200 | 59 | 567（16%） |

口径缺陷：

- `after_sales` 的定义是“近 90 天有付款订单”，老客的新询盘会被算成售后，流失被低估。
- “未下单”不等于流失：买家可能晚于窗口才下单，或换账号、转线下。
- 只有约 25% 的未下单会话客服文字 ≥50 字（10-12 至 10-17：285 / 1,148，此处未剔除售后），约每天 48 个。其余会话证据很少，本设计会诚实地标为“证据不足”。

## 3. 需求 1：可行性

| 内容 | 结论 | 说明 |
| --- | --- | --- |
| 产品净重、产品长宽高 | ✅ 能支持，可带入草稿 | 写入类目属性中同义的 `净重/重量/尺寸/外形尺寸` 文本字段；有枚举限制时走已有匹配逻辑 |
| 销售包装重量、包装长宽高 | ✅ 能支持，可带入草稿 | 映射到 `officialLogistics.offerInfo`（克、厘米、自动算体积），复用现有校验 |
| 按规格的重量尺寸 | ✅ 数据能存；带入需补界面 | 需与全部 SKU 一一对应，作为 P1 追加项 |
| 产品特性、材质、认证等 | ✅ 能支持，部分可带入 | 与类目字段同名或同义、且取值唯一匹配时带入；否则只留在 CRM |
| 自定义属性 | ✅ 能支持，一般只在 CRM | 平台只接受类目规则内的字段，不匹配的不提交 |
| **箱规**（装箱数、外箱尺寸、毛重） | ⚠️ 只存 CRM | 抽样类目不展示也不要求，且结构未核实，**不猜填**。待平台规则出现 `showBoxSpec=true` 并拿到样例后再接 |
| 回写已上架商品 | ❌ 本期不做 | 新属性不改线上商品；商品应用令牌归生产服务器，写操作风险也更高 |

**自动带入的优先级：** 草稿人工值 > 产品资料（已确认）> 采集属性 > 公共模板 > 平台默认。

**三层数据不能混用：** “净重”是产品本体，“含包装重量”是件重尺，“毛重”是外箱。现有 `SYNONYMS` 把“净重”和“重量”视为同义，只能用于类目属性，**绝不能用于件重尺**，否则会错算运费。

**已有草稿不静默改动。** 模板带入的值和人工填写的值目前无法区分，`hasMeasurements` 也会保护已有值。因此已有草稿改为提供“从产品资料带入”按钮：先展示差异，确认后才写入；`submitting/published/unknown` 状态不可操作。

## 4. 需求 1：设计

### 4.1 数据模型：迁移 `045_product_attributes.sql`（草案）

固定尺寸用类型化字段，便于校验和映射；特性和自定义用行表。单位统一存**克和毫米**整数：平台要求厘米最多一位小数，毫米能精确对应，也没有浮点误差。

```sql
BEGIN;
-- 尺寸重量箱规：variant_id 为空表示商品级，非空表示该规格的覆盖值
CREATE TABLE product_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES product_variants(id) ON DELETE CASCADE,
  net_weight_g integer CHECK (net_weight_g > 0),
  product_length_mm integer CHECK (product_length_mm > 0),
  product_width_mm integer CHECK (product_width_mm > 0),
  product_height_mm integer CHECK (product_height_mm > 0),
  package_weight_g integer CHECK (package_weight_g > 0),
  package_length_mm integer CHECK (package_length_mm > 0),
  package_width_mm integer CHECK (package_width_mm > 0),
  package_height_mm integer CHECK (package_height_mm > 0),
  carton_quantity integer CHECK (carton_quantity > 0),
  carton_gross_weight_g integer CHECK (carton_gross_weight_g > 0),
  carton_length_mm integer CHECK (carton_length_mm > 0),
  carton_width_mm integer CHECK (carton_width_mm > 0),
  carton_height_mm integer CHECK (carton_height_mm > 0),
  revision integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_product_measurements_product ON product_measurements(product_id) WHERE variant_id IS NULL;
CREATE UNIQUE INDEX uq_product_measurements_variant ON product_measurements(variant_id) WHERE variant_id IS NOT NULL;

-- 属性字典：按分类给出推荐字段，也是录入模板；category 为空表示全部分类
CREATE TABLE product_attribute_defs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category varchar(120),
  label varchar(60) NOT NULL,
  group_name varchar(30) NOT NULL DEFAULT '产品特性',
  value_type text NOT NULL DEFAULT 'text' CHECK (value_type IN ('text','number','select','multi_select','boolean')),
  unit varchar(20),
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  aliases text[] NOT NULL DEFAULT '{}',   -- 与平台类目字段名对应，如 {额定电压,电压}
  position integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_attribute_defs ON product_attribute_defs(tenant_id, coalesce(category,''), lower(label));

-- 产品属性值：def_id 为空即自定义属性
CREATE TABLE product_attributes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  def_id uuid REFERENCES product_attribute_defs(id) ON DELETE SET NULL,
  label varchar(60) NOT NULL,
  value text NOT NULL,
  unit varchar(20),
  group_name varchar(30) NOT NULL DEFAULT '产品特性',
  position integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','legacy','collected','listing','ai','import')),
  confirmed_at timestamptz,               -- 为空 = 待确认，不带入草稿，也不作为 AI 事实
  confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_product_attributes ON product_attributes(product_id, lower(label));
CREATE INDEX idx_product_attributes_tenant ON product_attributes(tenant_id, lower(label));

-- 回填现有规格：来自旧字段，视为已确认，保持现有行为
INSERT INTO product_attributes(tenant_id,product_id,label,value,source,confirmed_at)
SELECT p.tenant_id,p.id,left(s.key,60),s.value,'legacy',now()
FROM products p CROSS JOIN LATERAL jsonb_each_text(p.specifications) s
WHERE p.deleted_at IS NULL AND btrim(s.key)<>'' AND btrim(coalesce(s.value,''))<>''
ON CONFLICT DO NOTHING;
COMMIT;
```

**`specifications` 保留。** 写属性时同步生成一份投影（`名称 → 值+单位`），Agent、卡片摘要和现有接口都不用改。投影只由服务端生成，避免两份数据分叉。

历史值里的“1.2kg”不自动解析进类型化字段，而是作为待确认建议展示。

### 4.2 接口（草案）

| 方法与路径 | 用途 | 权限 |
| --- | --- | --- |
| `GET /api/products/:id/attributes` | 尺寸、属性、待确认建议 | `product:read` |
| `PUT /api/products/:id/measurements` | 保存尺寸（带 `revision` 防冲突，写审计） | `product:update` |
| `PUT /api/products/:id/attributes` | 保存属性列表（含自定义），并更新投影 | `product:update` |
| `POST /api/products/:id/attribute-suggestions/apply` | 采纳采集或在售快照的建议 | `product:update` |
| `GET/POST/PATCH /api/product-attribute-defs` | 属性字典 | 读 `product:read`；写 `product:update` |
| `GET /api/products/attributes/export`、`POST .../import?dryRun=` | CSV 批量导出、预检、导入（防公式注入） | `product:update` |
| `POST /api/integrations/1688/drafts/:id/product-attributes/preview`、`/apply` | 差异预览与带入（带草稿 revision） | 沿用草稿编辑权限 |

新增 `shared/product-attributes.ts`，放单位换算和映射的纯函数。映射规则：

- 件重尺：毫米转厘米，长宽高**按降序排列**以满足“长 ≥ 宽 ≥ 高”，体积自动计算。缺重量就不带入，也不把尺寸单独带入。
- 类目属性：从 `1688-collected-attributes.ts` 抽出 `sourceFor` 和枚举匹配逻辑复用。只用文本匹配，不用来源值 ID，因此可跨类目；多个候选时留空。
- 接入点：`createDraftFromProduct` 与 `routes/1688-agent.ts:89`。

### 4.3 页面（新导航）

- **商品 → 产品资料**：抽屉改为分区——基本信息 / 尺寸重量与箱规 / 产品特性 / 自定义属性 / 阶梯价。不再用自由文本框，从根本上解决全角冒号丢数据的问题。列表增加“资料完整度”筛选，页头增加“属性模板”和“导入导出”。
- **商品 → 采集箱**：转正式产品时，尺寸类数据作为待确认建议。
- **商品 → 在售商品**：详情展示绑定产品的属性；未绑定时提示“绑定后可用于复盘的产品知识”。
- **商品 → 发布草稿**：字段旁标注来源（产品资料/采集/模板），增加“从产品资料带入”。
- **设置**：不新增入口。

### 4.4 工作量

共 **8–10 人天**：迁移与接口 2；抽屉、字典界面 3；草稿映射与差异预览 2；CSV 与建议回填 1.5；测试与回归 1.5。按规格件重尺界面另加 2 人天。

## 5. 需求 2：可行性

| 甲方想知道 | 结论 | 能做到什么 | 做不到什么 |
| --- | --- | --- | --- |
| 业务员**响应**如何 | ✅ 数据能支持 | 首响、未回复、转接、工作时段内响应（已有） | 主账号共用时分不清具体的人 |
| 业务员**怎么聊的** | ⚠️ 只看单边 | 客服文字、话术占比、短回复、生硬用语、站外风险、是否主动推进 | 看不到买家问了什么，无法逐问逐答核对；看不到图片和卡片；其他渠道的沟通不可见 |
| 询盘**结果** | ✅ 数据能支持 | 下单、付款、取消、退款，退款原因真实 | 窗口外下单或线下成交会被误判为流失 |
| 询盘**关联商品** | ⚠️ 只能近似 | 已成交的可靠；未成交的靠链接、商品词、文字匹配，带置信度和覆盖率 | 大多数未成交询盘无法确定商品，也不知道买家是从哪个商品页进来的 |
| **是否熟悉产品** | ⚠️ 只能部分判断 | 客服说法与产品资料**冲突**、明确答不上来（需关联到商品且有资料） | **不能给出可靠的“熟悉度分数”**：没说错不代表熟悉，也不知道买家问了什么 |
| **因为什么流失** | ⚠️ 只能推断 | 无回复、响应慢：规则确定；议价、运费等：关键词加客服文字推断，有证据、可纠正 | 买家真实原因不可知；多数会话应标为“证据不足” |
| 历史分析 | ❌ 受限 | 新数据逐步累积；已入库消息可在平台仍返回内容时补文字和商品 ID | 10-10 之前基本无文字；超过 90 天的文字已清除；关键词不追溯 |

**明确不做：** 通过浏览器插件或脚本抓取客服网页旺旺里的买家原文。技术上也许可行，但等于绕过平台的脱敏，存在违反平台规则和个人信息合规方面的风险，可能影响店铺和应用授权。甲方如确有需要，应向 1688 官方申请数据权限，或先走法务评估。

合规的补充手段：

1. 主管在千牛里用自己的权限查看原文，再把判断录入复盘（本设计的“纠正”就是入口）。
2. 向平台确认 `wangwang.inqury.message.feedback` 的用途（文档只列了名称，看名字可能相关，不做假设）。

## 6. 需求 2：设计

### 6.1 分层思路

```
事实层（无 AI，每次同步后）  结果、响应、话术占比、关键词、退款原因、关联商品
   ↓ 证据足够的会话才往下走
AI 单会话复盘（每日批量）    问题事件、流失原因推断，每条必须引用消息证据
   ↓
主管确认或纠正              确认后才计入统计、才对业务员可见
   ↓
业务员日报与改进项          主管布置，业务员确认，按周看趋势
```

**先出规则结果，再加 AI。** 即使不开 AI，第一阶段也能回答“谁没回、谁慢、哪些询盘没成交、哪些商品被取消或退款多”。

### 6.2 会话与商品的关联

商品主键用 `offer_id`：订单、链接和在售缓存都有它。两个应用的 `connection_id` 不同，因此跨应用按 `tenant_id + offer_id` 连接，经 `integration_1688_listings.product_id` 再到产品资料（可为空）。

| 来源 | 置信度 | 用途 |
| --- | --- | --- |
| 主管手动指定 | 确定 | 全部 |
| 客服发送的商品链接（`linked_offer_ids`） | 高 | 全部 |
| 窗口内下单的商品（`perf_orders.items`） | 高（成交的商品，不一定是最初询问的商品） | 全部 |
| 消息命中商品词（货号/型号，唯一对应） | 中 | 全部，界面标注 |
| AI 在客服文字中识别的型号/品名，且唯一匹配目录 | 低 | 仅商品询盘统计，**不用于判定“答错”** |
| 买家近 90 天买过的商品 | 低 | 仅作上下文提示，不计入统计 |

所有商品维度报表都要显示**关联覆盖率**，避免把小样本当全貌。

### 6.3 流失原因与产品问题

原因分类（首版，可配置）：

| 代码 | 含义 | 判定来源 |
| --- | --- | --- |
| `no_reply` | 未回复或仅自动回复 | 规则 |
| `slow_reply` | 响应超阈值后买家不再发言 | 规则 |
| `price` | 价格、议价 | 关键词 + AI |
| `moq_freight` | 起订量、混批、运费 | 关键词 + AI |
| `stock_delivery` | 缺货、交期 | 客服文字 + AI |
| `product_mismatch` | 规格、功能不符 | 客服文字 + AI |
| `knowledge_gap` | 客服答不上或答错 | AI + 产品资料 |
| `no_followup` | 未主动推进、未再跟进 | AI + 规则 |
| `trust_aftersales` | 售后或信任顾虑 | 关键词 + AI |
| `browsing` | 买家仅比价或询问，意向弱 | AI（低置信度） |
| `unknown` | **证据不足（默认）** | — |

取消订单和退款直接用平台原因，不走 AI。

产品熟悉度**不打分，只记录事件**：`wrong_fact`（与已确认资料冲突，需同时具备高/中置信度商品关联和资料事实）、`cannot_answer`（明确答不上来）、`missed_spec`（商品已明确但回复中缺少关键参数，弱信号）。

### 6.4 数据模型

迁移 044 已用于商品链接 ID 提取（`perf_chat_messages.linked_offer_ids`）。后续编号实施前需再次核对，其他工作区可能已占用。

**`046_chat_product_signals.sql`（草案）**

```sql
BEGIN;
ALTER TABLE perf_keywords
  ADD COLUMN purpose text NOT NULL DEFAULT 'general' CHECK (purpose IN ('general','loss_signal','product')),
  ADD COLUMN offer_id text;
ALTER TABLE perf_orders ADD COLUMN close_reason text;  -- P0 抽样确认平台返回后才启用

CREATE TABLE chat_session_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES perf_chat_sessions(id) ON DELETE CASCADE,
  offer_id text NOT NULL,
  product_name text,
  source text NOT NULL CHECK (source IN ('manual','agent_link','order_after','keyword','ai_text','recent_order')),
  confidence text NOT NULL CHECK (confidence IN ('certain','high','medium','low')),
  evidence_message_uuid text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, offer_id, source)
);
CREATE INDEX idx_chat_session_products_offer ON chat_session_products(tenant_id, offer_id);
COMMIT;
```

**`047_chat_reviews.sql`（草案）**

```sql
BEGIN;
CREATE TABLE chat_review_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  daily_session_limit integer NOT NULL DEFAULT 200 CHECK (daily_session_limit BETWEEN 0 AND 2000),
  min_real_chars integer NOT NULL DEFAULT 30,
  model text NOT NULL DEFAULT 'qwen3.8-flash',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_review_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_1688_perf_connections(id) ON DELETE CASCADE,
  review_date date NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  worker_id text,
  lease_until timestamptz,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 候选数、跳过原因、token、估算费用
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (connection_id, review_date)
);

CREATE TABLE chat_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL UNIQUE REFERENCES perf_chat_sessions(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES perf_agents(id) ON DELETE CASCADE,
  run_id uuid REFERENCES chat_review_runs(id) ON DELETE SET NULL,
  chat_date date NOT NULL,
  evidence_level text NOT NULL CHECK (evidence_level IN ('rules_only','thin','sufficient')),
  ai_loss_code text,
  ai_loss_confidence text CHECK (ai_loss_confidence IN ('low','medium')),  -- 看不到买家原话，AI 最高只到 medium
  ai_findings jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{type,summary,message_uuid,excerpt,fact_ref}]
  ai_coaching text,
  model text, prompt_version text,
  input_tokens integer, output_tokens integer,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','corrected','dismissed')),
  final_loss_code text,
  final_findings jsonb,
  reviewer_note text,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  published_at timestamptz,        -- 发布后业务员本人可见
  agent_response text,             -- 业务员申诉或说明
  agent_responded_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_reviews_worklist ON chat_reviews(tenant_id, chat_date, status);
CREATE INDEX idx_chat_reviews_agent ON chat_reviews(agent_id, chat_date);

CREATE TABLE chat_coaching_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES perf_agents(id) ON DELETE CASCADE,
  review_id uuid REFERENCES chat_reviews(id) ON DELETE SET NULL,
  title varchar(200) NOT NULL,
  detail text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','done','dropped')),
  due_date date,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_coaching_agent ON chat_coaching_items(tenant_id, agent_id, status);

CREATE TABLE chat_agent_daily_briefs (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES perf_agents(id) ON DELETE CASCADE,
  brief_date date NOT NULL,
  stats jsonb NOT NULL,            -- 由 SQL 算出，模型不产生数字
  summary text,
  supervisor_note text,
  model text, prompt_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, brief_date)
);

UPDATE roles SET permissions=permissions||'["performance:review"]'::jsonb
  WHERE code='sales_manager' AND NOT permissions ? 'performance:review';
UPDATE roles SET permissions=permissions||'["performance:review_read"]'::jsonb
  WHERE code='executive' AND NOT permissions ? 'performance:review_read';
COMMIT;
```

结果（`no_order/paid` 等）**不落表**，每次按 `factsSql` 实时计算，这样窗口配置和后续下单都能即时生效。流失统计只纳入已过归属窗口的会话，未满窗口的显示为“观察中”。

`after_sales` 口径建议调整为“当天聊天与最近订单有售后关键词，或有进行中的退款”。但这会影响现有报表和工资 KPI，须由甲方确认，且应新增字段，不改现有口径。

### 6.5 AI 方案

| 项目 | 方案 |
| --- | --- |
| 模型 | `qwen3.8-flash`（项目默认，经 `server/llm/qwen.ts` 调用）：JSON 输出、低温度、关闭思考。可配置，上线前用标注集对比 `qwen3.7-plus` |
| 触发 | 每天北京时间 06:00 批量处理前一日（Worker 带租约，模式与 `startImageWorker` 相同），默认关闭。主管可对单个会话手动“重新分析” |
| 候选 | 非售后、未付款、已同步完成、去话术后真实文字 ≥30 字；另抽少量成交会话作对照。证据不足的只出规则结果，**不调模型** |
| 输入 | 时间线：客服遮盖文本；买家消息只写“买家发送 N 字”和关键词；响应时间；“其他消息”占位；已关联商品的**已确认属性** |
| 不发送 | 买家标识、业务员姓名和账号（用代号）、订单金额 |
| 话术处理 | 全店近 30 天重复 ≥5 次的文本标注为“疑似话术”，不作为个人能力依据 |
| 安全 | 聊天内容作为数据包裹，系统提示明确不执行其中的指令 |
| 输出校验 | zod 校验；`message_uuid` 必须属于该会话，否则丢弃该条；`wrong_fact` 必须引用资料字段；原因必须在分类内；不允许编造买家原话；AI 置信度最高为 `medium` |

**成本估算**（模型价格须在百炼控制台核实）：

- `qwen3.8-flash` 价格未查到。参考第三方转述的 `qwen3.7-flash` 价格（32K 以内：输入 0.2 元、输出 0.8 元/百万 token）。
- 单会话约 2,500 输入、400 输出 token。每天 150 会话（基于约每天 100 个未下单询盘留有余量）：`0.375M × 0.2 + 0.06M × 0.8 ≈ 0.12 元/天`。
- 每日简报（5 人，每人 3,000 输入、800 输出）约 0.006 元/天。
- 合计**约 4 元/月**。即使实际价格高 20 倍，也不到 100 元/月。用 `daily_session_limit` 设上限，每次运行的 token 和费用记入 `stats`。
- 不含助手对话，其单次约 13,000 输入 token（本地 14 次平均）。

**留痕：** 每条结果保存模型、提示词版本、token 和消息证据。主管操作写 `audit_logs`。重新分析不覆盖已确认或已纠正的结果。

**保留期：** `ai_findings.excerpt` 含客服原文，到 90 天时与 `text_masked` 一起清除；原因分类、事件类型和主管结论长期保留。

**误判纠正与校准：**

1. AI 结果默认 `pending`，只有主管可见，**不计入统计，不给业务员看**。
2. 主管可确认、改原因或事件、驳回（“不算问题”）或手动指定商品；业务员可对已发布的结果提交说明。
3. 上线前由主管标注约 100 个会话作为基准集。门槛（建议）：非 `unknown` 原因准确率 ≥70%；`wrong_fact` 精确率 ≥80%。未达标的类型不展示。
4. 运行后按类型统计纠正率；每次改提示词或模型都先跑基准集。主管纠正不自动进入提示词，由人工筛选后才加入示例。
5. **AI 结果不接入工资和 KPI。** 统计中默认只用主管确认的数据，“全部 AI 推断”需要手动切换并有明显标注。

### 6.6 接口（草案，挂在现有绩效路由前缀下）

| 方法与路径 | 用途 | 权限 |
| --- | --- | --- |
| `GET /inquiry-review/worklist` | 今日待复盘（优先级排序） | `performance:review` / `review_read` |
| `GET /inquiry-review/sessions/:id` | 时间线、事实、关联商品、AI 结果 | 同上；本人仅限已发布 |
| `POST /inquiry-review/sessions/:id/analyze` | 手动分析单个会话 | `performance:review` |
| `PATCH /inquiry-review/reviews/:id` | 确认、纠正、驳回、发布（带 `revision`） | `performance:review` |
| `POST /inquiry-review/reviews/:id/response` | 业务员说明 | `performance:read_own` 且为本人 |
| `PUT/DELETE /inquiry-review/sessions/:id/products` | 手动指定商品 | `performance:review` |
| `GET /inquiry/loss-analysis` | 原因分布、按客服和商品，含覆盖率 | `performance:review` / `review_read` |
| `GET /inquiry/products` | 商品询盘→下单→付款、取消与退款原因 | `performance:read`；本人范围 |
| `GET /agents/:id/daily-brief`、`GET/POST/PATCH /coaching-items` | 日报与改进项 | 见第 7 节 |
| `GET/PUT /inquiry-review/settings` | 开关、限额、模型 | `performance:manage` |

助手工具（`ai-assistant-tools.ts`）新增 `get_inquiry_review_summary`，只读，权限同上，只返回确认后的结果。

### 6.7 页面（新导航）

- **聊天 → 询盘复盘（新增页签，放第一屏工作入口）**：主管每日工作台。
  - 顶部：昨日询盘、流失、观察中、待确认、证据不足占比。
  - 列表优先级：未回复流失 > 可能答错 > 站外风险 > 高意向未成交（多轮对话、命中定制/大货词）。每人默认最多 10 条，避免主管看不完。
  - 详情抽屉：左边时间线（买家显示为“买家消息（N 字）”），右边结果、证据跳转、商品关联、确认和纠正。必须常驻提示“买家内容不可见，结论为推断”。
- **聊天 → 询盘分析**：新增流失原因分布、商品询盘榜，每个图标注样本量和覆盖率。
- **聊天 → 聊天记录**：会话详情增加关联商品和复盘状态。
- **绩效 → 业务员复盘（新增页签）**：选业务员看日报、7 日对比、已确认问题、改进项及趋势。业务员本人看自己的。
- **绩效 → 回复质量**：增加“话术占比”，避免把话术当人工回复。
- **绩效 → 关键词**：新增“流失信号”和“商品词”两组预设（第 8 节 P0）。
- **商品 → 在售商品**：详情增加询盘数、转化、主要流失原因（第三期）。
- **设置 → 绩效规则**：增加复盘开关、限额。**设置 → 调用记录**：增加 AI 复盘费用。
- **首页**：主管卡片“昨日待复盘 N 条”。

## 7. 权限

| 角色 | 产品属性 | 询盘复盘 |
| --- | --- | --- |
| 管理员 `admin/super_admin` | 全部 | 全部（已有通配） |
| 主管 `sales_manager` | 全部 | 新增 `performance:review`：工作台、纠正、发布、改进项 |
| 高管 `executive` | 目前无 `product:read`，导航不显示；需要时另行授权 | 新增 `performance:review_read`：只读 |
| 财务 `finance` | 同上 | **默认不可见**（虽有 `performance:read`）；避免 AI 推断流入工资判断 |
| 业务员 `sales_rep` | 只读 | `performance:read_own`：只看本人**已发布**的结果和改进项，可写说明；不看他人 |

补充：

- 本人范围依赖 `perf_agents.user_id`，**目前全部未绑定，上线前必须在“设置 → 客服账号”完成绑定**。
- 产品 `GET` 接口目前只要求登录，未检查 `product:read`。如属性中含敏感信息（如成本），需收紧；本设计不含成本字段。

## 8. 分期与工作量

| 阶段 | 内容 | 工作量 | 验收 |
| --- | --- | --- | --- |
| **P0 数据核实与开启积累** | 生产只读抽样（只看字段名和比例）：消息和订单是否还有商品或取消原因字段；复核第 2 节比例。甲方确认后添加关键词；绑定客服账号 | 1–2 人天 + 甲方配合 | 抽样报告；关键词开始命中；账号绑定完成 |
| **P1 产品属性** | 第 4 节全部 | 8–10 人天 | 新建/导入/带入草稿回归；模拟网关校验；不做真实平台写入 |
| **P2 事实层与工作台（无 AI）** | 迁移 046、商品关联、规则原因、询盘复盘列表、商品询盘报表 | 6–8 人天 | 事实与现有报表口径一致；覆盖率可见 |
| **P3 AI 复盘试运行** | 迁移 047、Worker、提示词、校验、基准集、纠正流程。**仅主管可见** | 6–8 人天 + 主管标注约 100 会话 | 达到第 6.5 节门槛；试运行 2 周 |
| **P4 业务员闭环** | 日报、改进项、发布与申诉、助手工具、商品页统计 | 4–5 人天 | 主管连续使用 2 周并确认有用 |

合计约 **25–33 人天**（P1 可与 P2 并行，但 P3 的“答错”判定依赖 P1 的产品资料）。

**P0 建议添加的关键词**（现有预设已有“售后退款、投诉差评、物流催单、发票、议价、定制大单”，下面是新增部分，由甲方增删；平台词数上限待确认）：

| 分组 | 词 |
| --- | --- |
| 流失信号·价格 | 太贵、贵了、少点、能便宜、别家便宜 |
| 流失信号·起订与运费 | 起订、混批、起批、运费、到付 |
| 流失信号·现货与交期 | 现货、没货、有货吗、多久发、交期 |
| 流失信号·产品 | 型号、尺寸、多重、功率、质保、保修、说明书 |
| 流失信号·犹豫 | 再看看、考虑一下、对比、同款 |
| 商品词 | 主推商品的货号或型号（每词唯一对应一个商品，最多 20 字，不能含空格或逗号） |

关键词只说明“提到过”，不说明态度（“不贵”也可能命中），因此只作线索。

**依赖：**

1. 新导航尚未提交，只在主检出工作区。涉及的 `src/ProductsPage.tsx`、`src/ChatInquiryPage.tsx`、`src/PerformancePage.tsx` 都有未提交改动，**应先提交导航重设计再开发**。
2. 产品资料的覆盖面决定“答错”判定能做到什么程度：13 个产品资料对比订单中的 441 个商品。可以从在售快照批量建立，但需要**同步到位并完成绑定**；也可以先只覆盖主推商品。
3. `npm run start:api` 会启动 Worker 和上架队列。开发验证需用模拟模型和网关，不在本地调用 1688 商品应用接口。

**风险：**

| 风险 | 应对 |
| --- | --- |
| 甲方期望“看到真实流失原因” | 签约前说明；界面常驻提示；默认标为“证据不足” |
| AI 误判影响业务员 | 确认后才可见；不接工资；可申诉 |
| 业务员有意回避文字（多用语音、电话或卡片） | 话术占比和“其他消息”占比一并展示，不只看文字 |
| 关键词配额或误命中（如“不贵”也命中“贵”） | P0 确认上限；关键词只算线索，不单独定因 |
| 绩效应用日配额（开发期 5,000 次/天） | 本方案基本不增加平台调用（关键词维护和文字补采除外） |

## 9. 需要甲方确认的问题

1. **接受边界吗？** 平台不提供买家原话，流失原因和产品熟悉度只能是“带证据的推断 + 主管确认”。这是整个需求 2 的前提。
2. **业务员是否各用各的子账号？** 目前 98% 的会话在主账号上。如果多人共用主账号，需先改接待方式，否则无法按人分析。同时请提供账号与人员的对应关系。
3. **是否同意在店铺添加关键词？** 这是对平台的写操作（建议清单见第 8 节），会改动旺旺关键词库。建议尽早开始，因为不追溯。
4. **哪些算流失？** 默认：非售后询盘 72 小时未下单。是否延长窗口？是否要把“老客新询盘”从售后中拆出来（会影响现有报表）？
5. **需要哪些属性？** 请提供各品类的字段清单和箱规口径（毛重/净重、外箱尺寸、是否按规格区分）。箱规只存 CRM 是否可以接受？
6. **产品资料由谁维护，先覆盖哪些商品？** 建议先做主推的 30–50 个，这决定“答错”判定的覆盖面。
7. **主管每天能投入多久？** 决定每日工作台条数（默认每人 10 条）和基准集的标注安排。
8. **复盘能否影响考核？** 本设计默认不影响工资和 KPI，只用于辅导。
9. **告知与隐私：** 分析客服聊天并发送遮盖后的文字到阿里云百炼，是否需要告知员工？客服文本保留 90 天是否够用？
10. **预算：** 是否接受第 8 节的分期和工作量？是否从 P0 + P1 开始？

## 10. 实施情况（2026-11-05）

**已完成：** 迁移 044–047；产品尺寸箱规、特性、自定义属性、属性模板、CSV 导入导出、新草稿和 Agent 补空带入、已有草稿差异带入；会话商品关联、规则流失原因、询盘复盘工作台、流失原因和商品询盘报表；AI 复盘 Worker（默认关闭）、主管确认和纠正、发布与业务员说明；业务员日报、改进项、助手工具；流失信号关键词预设和商品词。

**与设计的差异：**

- 尺寸和属性合并为一个接口 `PUT /api/products/:id/attributes`；采纳建议在表单内完成后一起保存，不设单独接口。
- 主管决定的接口是 `PUT /inquiry-review/sessions/:id/review`，这样没有 AI 结果的会话也能判断。
- AI 复盘设置放在“聊天 → 询盘复盘”页内，没有放到“设置 → 绩效规则”。
- `perf_orders.close_reason` 未加：要等 P0 抽样确认平台返回该字段。
- 修复了 `PATCH /api/products/:id` 的缺陷：`.partial()` 仍会应用默认值，未传的状态、价格和规格会被重置。

**尚未完成：**

| 项目 | 原因 |
| --- | --- |
| P0 生产抽样、添加关键词、绑定客服账号 | 需要在生产环境操作并由甲方确认 |
| 真实模型验证和约 100 个会话的基准集 | 目前只用模拟模型测试；**未达第 6.5 节门槛前不要打开 AI 复盘** |
| 首页待复盘卡片、在售商品详情的属性和询盘统计、回复质量页的话术占比 | 尚未开发；新导航已合并，可以继续做 |
| 按规格件重尺的界面和接口 | 表结构已支持，属于 P1 追加项 |
| AI 从客服文字识别商品（`ai_text`） | 枚举已留，尚未产生数据；目前靠链接、订单、商品词和手动指定 |

**新导航：** 已接入。“询盘复盘”在 聊天 下（`#/chats/review`，仅 `performance:review` 或 `performance:review_read` 可见），“业务员复盘”在 绩效 下（`#/performance/coaching`）。

**产品目录合并（2026-11-05，取代第 4.3 节的页面划分）：** “在售商品”和“产品资料”合并为导航栏独立入口“产品目录”（`#/catalog/all`），原“商品”入口改名“上架”，只留采集箱、上架队列、发布草稿；旧链接 `#/products/listed`、`#/products/library` 自动跳转。

- 平台商品就是目录：详情同时显示 1688 的信息（只读，来自上次同步）和 CRM 补充的尺寸、箱规、自定义属性。
- 点“补充资料”时才建立 CRM 产品，并与平台商品一对一关联（SKU 取货号，已被占用时用 `1688-商品ID`；规格一并建立），不写平台。
- 手动添加的产品，以及采集后还没上架的产品，放在“未上架”。平台商品被删除后，产品和资料回到这里。
- 查看需要 `product:read` 或 `integration:read`，这样业务员也能查产品资料；近 30 天销量只给有 `integration:read` 或 `performance:read` 的账号。

**部署：** 先执行迁移 044–047（`database/mac.sh` 或 `database/init-db.ps1`），再更新代码。Worker 随 API 启动，默认只刷新商品关联和生成数据日报，不调用模型。

## 附：现有代码的相关问题（设计范围外，供排期）

- 产品抽屉的规格文本框会静默丢弃全角冒号的行（`src/ProductsPage.tsx` 的 `submit`）。P1 改版后消除；如 P1 延后，建议先单独修。
- ~~`analyzeAgentText` 遮盖了商品链接 ID~~：已提前修复（迁移 044，`server/integrations/chat-text.ts`）。部署到生产后才开始生效。
