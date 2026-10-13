// 课堂演示的共享契约（规格 §4.1）。本文件不 import store，也不 import decide/runner/script。
import type { MaterialId } from '../utils/rules';
import type { MarketId } from '../config/marketDemand';
import type { RuleRef } from '../components/RulesModal';

export type { RuleRef };

// 本期只开放 P1/P2（课程约束），所以意图与动作里不用 ProductId 的 P3/P4 分支
export type PlayableProduct = 'P1' | 'P2';
export type LineType = 'automatic' | 'semi-automatic' | 'manual' | 'flexible';
export type IsoType = 'ISO9000' | 'ISO14000';

/** 剧本意图：只声明决策级别，不声明"选哪张单、下几个料"（规格 §4.4） */
export interface YearIntent {
  year: 1 | 2 | 3 | 4;
  /** 年初广告投放金额；决定解锁订单张数（每 1M 解锁 2 张） */
  adAmount: number;
  /** 本年选单张数上限 */
  orderCap: number;
  /** 本年要新增的生产线（按厂房声明，decide 每季最多落地一条） */
  newLines: { factoryId: string; lineType: LineType; product: PlayableProduct }[];
  /** 本年是否推进 P2 研发 */
  rdP2: boolean;
  /** 本年要投资的市场（开拓 + 已准入维持都走同一个 action，含 local 维持） */
  marketInvest: MarketId[];
  isoInvest: IsoType[];
  /** 哪几季度申请短贷（门控只放行第 1、3 季度） */
  shortLoanQuarters: number[];
  /** 年末是否申请长贷 20M（未还本余额上限 40M） */
  longLoan: boolean;
  /** 可选：出售某个已腾空的自有厂房（q-12） */
  sellFactory?: string;
  /** 现金安全垫基线；实际下限是它加上引擎下季自动支出，见 decide.estAutoOutlay */
  cashPad: number;
}

/** runner 唯一能把它们映射到 store action 的动作描述符 */
export type DemoOp =
  | { kind: 'payTaxes' }
  | { kind: 'placeAdvertisement'; amount: number }
  | { kind: 'enterOrderMeeting' }
  | { kind: 'selectOrder'; orderId: string }
  | { kind: 'applyShortTermLoan' }
  | { kind: 'applyLongTermLoan' }
  | { kind: 'discountReceivable'; amount: number }
  | { kind: 'placeRawMaterialOrder'; materialType: MaterialId; quantity: number }
  | { kind: 'addProductionLine'; factoryId: string; lineType: LineType; product: PlayableProduct }
  | { kind: 'startProduction'; lineId: string }
  | { kind: 'deliverOrder'; orderId: string }
  | { kind: 'investProductR_D' }
  | { kind: 'investMarketDevelopment'; marketType: MarketId }
  | { kind: 'investISOCertification'; isoType: IsoType }
  | { kind: 'sellFactory'; factoryId: string }
  | { kind: 'nextQuarter' };

export interface DemoStep {
  /** CONTROL_STEPS 的 id：界面名、CSV 行位、财务日志三处共用同一个键 */
  stepId: string;
  op: DemoOp;
}

export type RunnerPhase = 'idle' | 'playing' | 'paused' | 'blocked' | 'finished';

export interface BlockedInfo { year: number; quarter: number; label: string; reason: string }
