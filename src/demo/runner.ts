// 演示驱动层（规格 §4.6）：它是唯一 import store 的 demo 模块。决策在 decide.ts、剧本在 script.ts，
// 这里只做三件事——把动作描述符映射到真实 action、按步进播放、撞门就停下来说清楚。
//
// 面板（Task 8 的 DemoPanel）读这两个字段的分工是**固定的**，别混用：
// - **讲解卡读 `lastStep`**（刚成功执行的那一步，它的 rule/label 就是屏幕上该念的那条规则原文，规格 §4.7）；
//   读 `queue[0]` 会错一格——讲解点自动停的时候，`queue[0]` 已经是"下一步"了。
// - **进度读 `queue.length`**（本季还剩几步）；年季读数直接取 store 的 `operation`。
import { create } from 'zustand';
import { useEnterpriseStore } from '../store/enterpriseStore';
import { CONTROL_STEPS } from '../utils/controlTable';
import { absQuarter } from '../utils/rules';   // skipQuarter 用它判季界
import type { BlockedInfo, DemoOp, DemoStep, RunnerPhase } from './types';
import { decideQuarter, pickOrders } from './decide';
import { YEAR_INTENTS, pausePointFor } from './script';

export interface RunningStep extends DemoStep {
  /** 控制表行名（CONTROL_STEPS 单源） */
  name: string;
  /** 这步具体做了什么，面板显示 */
  label: string;
  rule?: import('./types').RuleRef;
  isPausePoint: boolean;
}

const stepName = (stepId: string) => CONTROL_STEPS.find((s) => s.id === stepId)?.name ?? stepId;

export const describeOp = (op: DemoOp): string => {
  switch (op.kind) {
    case 'payTaxes': return '支付应付税金';
    case 'placeAdvertisement': return `投放广告 ${op.amount}M`;
    case 'enterOrderMeeting': return '参加订货会，生成当年订单池';
    case 'selectOrder': return '选择一张订单';
    case 'applyShortTermLoan': return '申请短期贷款 20M';
    case 'applyLongTermLoan': return '申请长期贷款 20M';
    case 'discountReceivable': return `贴现应收账款 ${op.amount}M`;
    case 'placeRawMaterialOrder': return `下原料订单 ${op.quantity} 个${op.materialType}`;
    case 'addProductionLine': return `在${op.factoryId}新建一条${op.lineType}线（产${op.product}）`;
    case 'startProduction': return `开工：${op.lineId}`;
    case 'deliverOrder': return '按订单交货';
    case 'investProductR_D': return '启动 P2 研发（1M/季 × 6 季）';
    case 'investMarketDevelopment': return `投资市场开拓/维持：${op.marketType}`;
    case 'investISOCertification': return `投资 ${op.isoType} 认证`;
    case 'sellFactory': return `出售厂房：${op.factoryId}`;
    case 'nextQuarter': return '推进到下季度（引擎自动结算）';
  }
};

const dispatch = (op: DemoOp): void => {
  const s = useEnterpriseStore.getState();
  switch (op.kind) {
    case 'payTaxes': s.payTaxes(); break;
    case 'placeAdvertisement': s.placeAdvertisement(op.amount); break;
    case 'enterOrderMeeting': s.enterOrderMeeting(); break;
    case 'selectOrder': s.selectOrder(op.orderId); break;
    case 'applyShortTermLoan': s.applyShortTermLoan(); break;
    case 'applyLongTermLoan': s.applyLongTermLoan(); break;
    case 'discountReceivable': s.discountReceivable(op.amount); break;
    case 'placeRawMaterialOrder': s.placeRawMaterialOrder(op.materialType, op.quantity); break;
    case 'addProductionLine': s.addProductionLine(op.factoryId, op.lineType, op.product); break;
    case 'startProduction': s.startProduction(op.lineId); break;
    case 'deliverOrder': s.deliverOrder(op.orderId); break;
    case 'investProductR_D': s.investProductR_D('P2'); break;
    case 'investMarketDevelopment': s.investMarketDevelopment(op.marketType); break;
    case 'investISOCertification': s.investISOCertification(op.isoType); break;
    case 'sellFactory': s.sellFactory(op.factoryId); break;
    case 'nextQuarter': s.nextQuarter(); break;
  }
};

// 当季意图：expand() 与订货会后的补选都用它，两处必须是同一份，否则选单口径会漂
const currentIntent = () =>
  YEAR_INTENTS[useEnterpriseStore.getState().state.operation.currentYear as 1 | 2 | 3 | 4];

// 讲解点"只自动停一次"靠它，模块级即可：start() 会清空
let seenPausePoints = new Set<string>();

/** 给决策层的裸步骤补上面板要显示的元信息（讲解点、控制表行名、动作描述） */
const decorate = (d: DemoStep): RunningStep => {
  const point = pausePointFor(d.stepId);
  return {
    ...d,
    name: stepName(d.stepId),
    label: describeOp(d.op),
    rule: point?.rule,
    isPausePoint: !!point && !seenPausePoints.has(d.stepId),
  };
};

const expand = (): RunningStep[] => {
  const s = useEnterpriseStore.getState().state;
  if (s.operation.isGameOver) return [];
  return decideQuarter(s, currentIntent()).map(decorate);
};

/**
 * 订货会**之后**补一次选单：订单池是 enterOrderMeeting 现场生成的（id 含 `Date.now()`，
 * store:1748），季初那次 expand() 里 `availableOrders` 还是空池，`pickOrders` 必然空手而归——
 * 真跑第一次就表现为"全年零选单、库存堆着、现金只出不进"。
 * 这里只就新状态再问决策层同一个谓词（pickOrders 仍是单源，runner 不复算挑选规则），
 * 拿回来的只有 selectOrder 那几步；不整季重跑 expand()——重跑会二次投广告、二次下单，那是数据损坏。
 * 队列位序仍由 decideQuarter 说了算（选单在年初段、投料/开工/交货在其后）。
 */
const selectStepsAfterMeeting = (): RunningStep[] => {
  const s = useEnterpriseStore.getState().state;
  if (s.operation.isGameOver) return [];
  return pickOrders(s, currentIntent()).map((orderId) =>
    decorate({ stepId: 'b-2', op: { kind: 'selectOrder', orderId } }),
  );
};

/**
 * 执行一步，返回是否被拒。判据用 **state 引用**而不是 validationError：
 * 成功路径都返回新的 state 对象，被拒路径只塞一句 validationError（store 各门的既有写法），
 * 所以"引用没变"才是结构性的失败信号；validationError 只负责提供那句人话原因。
 * store 里还有 `return state` 式的静默守卫（如 :1533 原料类型找不到、:2051 订单不存在或已交），
 * 它们不改引用也不报错——那种情况自己造一句原因，别让它静默滑过去。
 * 行号是 Task 7 真跑时逐个查过的，不是抄来的。
 */
const advanceOne = (): { ok: boolean } => {
  const runner = useDemoRunner.getState();
  const [head, ...rest] = runner.queue;
  // 队列空掉只可能是编排漏了推进步：宁可停出来说话，也不要在这里偷偷 expand() 重跑一遍本季
  // （重跑会二次投广告、二次下单，那是数据损坏而不是停住）
  if (!head) {
    const op = useEnterpriseStore.getState().state.operation;
    useDemoRunner.setState({
      phase: 'blocked',
      blocked: { year: op.currentYear, quarter: op.currentQuarter, label: '本季动作序列', reason: '队列已空但没走到推进步，编排层有 bug' },
    });
    return { ok: false };
  }

  const store = useEnterpriseStore.getState();
  const { currentYear, currentQuarter } = store.state.operation;
  store.setValidationError(null);
  const before = useEnterpriseStore.getState().state;
  dispatch(head.op);
  const after = useEnterpriseStore.getState().state;

  if (after === before) {
    const reason = useEnterpriseStore.getState().validationError
      ?? '此步未改动任何状态（store 的静默守卫，例如目标已不存在或已交付）';
    useDemoRunner.setState({
      phase: 'blocked',
      blocked: { year: currentYear, quarter: currentQuarter, label: `${head.name}｜${head.label}`, reason },
      queue: [head, ...rest],   // 保留这一步，"重试此步"才有的可重
    });
    return { ok: false };
  }

  // 就地 add 而不是 `new Set([...seen, x])`：tsconfig target 是 es5，展开 Set 要 downlevelIteration。
  // 这个集合是模块级私有、不进 zustand，所以不存在"外部握着旧引用看到突变"的暴露面。
  // **次序是承重的**（本行必须排在下面补选那一段之前）：先登记这个讲解点，`selectStepsAfterMeeting()`
  // 里 decorate 出来的同 stepId（b-2）选单步才会被判成非讲解点。反过来写，b-2 会在同一季被触发第二次暂停。
  if (head.isPausePoint) seenPausePoints.add(head.stepId);

  // 订货会刚把池子生成出来 → 现场补一轮选单，插在剩余步之前（详见 selectStepsAfterMeeting）
  const freshPicks = head.op.kind === 'enterOrderMeeting' ? selectStepsAfterMeeting() : [];
  // 季初那批 selectOrder 步**一律作废**（与补选是否挑到单无关）：enterOrderMeeting 每次整替订单池
  // （store:1791），季初对着旧池算出来的 id 在这一刻之后必然失效。留着它们，补选为空的年份
  // （池子只剩产能为 0 的产品、或广告额 0 → unlocked 0）就会撞 store:2029「该订单不在可选列表中」当场 blocked。
  const remaining = head.op.kind === 'enterOrderMeeting'
    ? rest.filter((s) => s.op.kind !== 'selectOrder')
    : rest;

  // nextQuarter 之后必须换季重算；一季跑完（remaining 空）也重算，防止剧本在某季多产步
  const finishedGame = head.op.kind === 'nextQuarter'
    && useEnterpriseStore.getState().state.operation.isGameOver;
  const nextQueue = head.op.kind === 'nextQuarter' || remaining.length === 0 ? expand() : [...freshPicks, ...remaining];

  if (finishedGame) {
    useDemoRunner.setState({ queue: [], phase: 'finished', blocked: null, lastStep: head });
    return { ok: true };
  }
  // 相位：讲解点自动停；被拒后重试成功也要从 blocked 拉回 paused（blocked 字段已经在下面清了，
  // 相位不动的话面板显示"被拒但报错区已空"，而 skipQuarter 见 blocked 就早退、前进不了也退回播放）。
  const cur = useDemoRunner.getState().phase;
  useDemoRunner.setState({
    queue: nextQueue,
    blocked: null,
    lastStep: head,
    phase: head.isPausePoint || cur === 'blocked' ? 'paused' : cur,
  });
  return { ok: true };
};

// 规格 §4.6 的下限。Task 7 真跑给它加了第二个理由：`Date.now()` 不只进日志，还进**业务主键**
// （订货会订单 id = `order-${Date.now()}-${i}`，store:1748；原料单 id 原来是 `order-${Date.now()}`、
// 不带序号，store:1542），同毫秒的两次订货会会撞出同 id 的两张单，交货时一次标记两张却只扣一张的库存与应收。
// **但这条下限只管得到 `play()`**：`step()` 与 `skipQuarter()` 是同步批量，一次调用就把整季的步走完，
// 相邻两步常常落在同一个毫秒，下限根本拦不住它们。同毫秒碰撞的正解是让 id 带序号（原料单已在 store 侧修掉），
// 不是靠时间间隔；测试里则显式装时钟（见 tests/demoRun.test.ts 的 withStepClock / withFrozenClock）。
// 所以 300ms 的本来含义保留：它是**播放**时避开核对盲区（§3）的最小值，不是手感参数。
const MIN_SPEED_MS = 300;

interface DemoRunner {
  phase: RunnerPhase;
  queue: RunningStep[];
  blocked: BlockedInfo | null;
  /** 刚成功执行的那一步（讲解卡的数据源；start/restart/exit 清空，见文件头分工说明） */
  lastStep: RunningStep | null;
  speedMs: number;
  start: () => void;
  step: () => void;
  play: () => void;
  pause: () => void;
  skipQuarter: () => void;
  restart: () => void;
  exit: () => void;
  setSpeed: (ms: number) => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;
const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

export const useDemoRunner = create<DemoRunner>((set, get) => ({
  phase: 'idle',
  queue: [],
  blocked: null,
  lastStep: null,
  speedMs: 600,

  // 进入演示：换到内存里的全新开局态（store 侧 enterDemo 已拍好快照），展开第一季
  start: () => {
    useEnterpriseStore.getState().enterDemo();
    seenPausePoints = new Set<string>();
    set({ phase: 'paused', queue: expand(), blocked: null, lastStep: null });
  },

  step: () => { advanceOne(); },

  play: () => {
    if (get().phase === 'playing' || get().queue.length === 0) return;
    set({ phase: 'playing' });
    const tick = () => {
      const r = advanceOne();
      if (!r.ok || useDemoRunner.getState().phase === 'finished') { clearTimer(); return; }
      if (useDemoRunner.getState().phase === 'paused') { clearTimer(); return; }   // 讲解点到了就停
      timer = setTimeout(tick, Math.max(MIN_SPEED_MS, get().speedMs));
    };
    timer = setTimeout(tick, Math.max(MIN_SPEED_MS, get().speedMs));
  },

  pause: () => { clearTimer(); set({ phase: 'paused' }); },

  // 跳到下一季：把当季剩余步跑完，年/季一变就停；撞门也停在那儿让老师看原因。
  // guard 计数是必要的兜底：nextQuarter 那一步永远排在本季末尾（decideQuarter 保证），所以季界变化必然发生，
  // 但剧本万一在某季产出了空队列，没有这道闸这个 while 就转不完。
  skipQuarter: () => {
    clearTimer();
    // 先落回 paused 再跑循环：这是**同步批量**，没有 play() 的 300ms timer 在背后驱动。
    // 从 playing 进来却只在末尾留着 playing 的话，面板显示"播放中"，而 play() 首行的
    // `phase === 'playing'` 早退会让它一步都走不动。循环内部再按需转 blocked/finished。
    set({ phase: 'paused' });
    const startAbs = absQuarter(
      useEnterpriseStore.getState().state.operation.currentYear,
      useEnterpriseStore.getState().state.operation.currentQuarter,
    );
    for (let guard = 0; guard < 100; guard++) {
      const r = useDemoRunner.getState();
      if (r.phase === 'blocked' || r.phase === 'finished' || r.queue.length === 0) return;
      advanceOne();
      const now = useEnterpriseStore.getState().state.operation;
      if (absQuarter(now.currentYear, now.currentQuarter) !== startAbs) return;
    }
  },

  // 重新开始 = 先退出演示（把老师的当前屏换回来）再重进（拍新快照、换一份开局态）。
  // 不能只调 start()：enterDemo 在 demoMode 为 true 时是幂等早退（store:551，Task 1 有测试钉着它），
  // 只调 start 会对"当前半年季"重跑 decideQuarter——二次扣广告、整替订单池、可能二次借短贷，
  // 那正是 advanceOne 空队列分支里写的"数据损坏而不是停住"。
  restart: () => {
    clearTimer();
    useEnterpriseStore.getState().exitDemo();
    get().start();
  },

  exit: () => {
    clearTimer();
    useEnterpriseStore.getState().exitDemo();
    set({ phase: 'idle', queue: [], blocked: null, lastStep: null });
  },

  setSpeed: (ms) => set({ speedMs: Math.max(MIN_SPEED_MS, ms) }),
}));
