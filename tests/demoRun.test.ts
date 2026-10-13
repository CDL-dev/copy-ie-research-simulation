// 全速跑完一局（规格 §6 第 2 组）：这条是"剧本与规则不脱钩"的唯一守卫——
// 规则改了剧本失效，它先红。不经 UI，直接驱动 runner 的 step()，所以无 jsdom 也能测。
import { beforeEach, describe, expect, it } from 'vitest';
import { createFreshState, useEnterpriseStore } from '../src/store/enterpriseStore';
import { useDemoRunner, type RunningStep } from '../src/demo/runner';
import type { DemoOp } from '../src/demo/types';

const store = () => useEnterpriseStore.getState();
const runner = () => useDemoRunner.getState();

/** decorate 没导出，测试里手写 RunningStep 的元信息（面板字段对逻辑无关紧要） */
const mkStep = (stepId: string, op: DemoOp, isPausePoint = false): RunningStep => ({
  stepId, op, name: stepId, label: '测试构造的步', isPausePoint,
});

/**
 * 规格 §4.6 的 300ms/步下限在这里必须显式装上，不是加速手感：订货会的订单 id 是
 * `order-${Date.now()}-${i}`（store:1748），四个年度四次订货会若落进**同一毫秒**就会造出
 * 同 id 的两张单；`selectOrder` 按 id 搬运（store:2023-2044）会让 selectedOrders 里出现两个同 id
 * 条目，`deliverOrder` 用 `map(o => o.id === orderId ? {…isDelivered:true} : o)`（store:2061）
 * 一次把两张都标记已交、却只扣一张的库存与应收，第二条交货步随即撞 :2052 的静默守卫
 * （`targetOrder.isDelivered` → `return state`）→ runner 判撞门。
 * 真界面有 300ms 限速兜着，同步连推 16 季没有，于是"16 季零撞门"退化成同毫秒碰撞的概率题
 * （实测：同一份剧本连跑三次，第二次就在第2年第4季的交货步撞门）。
 * 这里让每次 Date.now() 前进 300ms——把规格自己的前提装回测试，**不放宽任何断言**，
 * 测的是剧本与资金曲线，不是 id 撞车的运气。引擎侧的根因（id 不含年季）已进 Task 7 报告。
 */
const MIN_STEP_MS = 300;
const withStepClock = (run: () => void): void => {
  const real = Date.now;
  let last = real();
  Date.now = () => { last += MIN_STEP_MS; return last; };
  try { run(); } finally { Date.now = real; }
};

/** 整局里每种 op.kind 各执行了几步（规格 §10 第 12 条的读数按这个口径锁死） */
type OpCounts = Record<string, number>;

const driveFullRun = (counts?: OpCounts) => {
  withStepClock(() => {
    runner().start();
    // 一季最多约 12 步 × 16 季，4000 是宽松上限；撞门会立刻停在 blocked
    for (let i = 0; i < 4000 && runner().phase !== 'finished' && runner().phase !== 'blocked'; i++) {
      const before = runner().lastStep;
      runner().step();
      const after = runner().lastStep;
      // lastStep 只在成功那一步换引用（被拒不写），所以"引用变了"就是"这步真执行了"
      if (counts && after && after !== before) counts[after.op.kind] = (counts[after.op.kind] ?? 0) + 1;
    }
  });
  return runner();
};

beforeEach(() => {
  useEnterpriseStore.setState({ state: createFreshState(), saveFiles: [], validationError: null, demoMode: false, demoSnapshot: null });
  useDemoRunner.setState({ phase: 'idle', queue: [], blocked: null, lastStep: null });
  localStorage.removeItem('enterpriseSaveFiles');
});

describe('完整一局自动跑通', () => {
  it('16 季零撞门，跑到 finished', () => {
    const r = driveFullRun();
    expect(r.blocked).toBeNull();
    expect(r.phase).toBe('finished');
    expect(store().state.operation.isGameOver).toBe(true);
  });

  it('全程零落盘：自动存档被 demoMode 闸住', () => {
    store().saveGame();
    const baseline = localStorage.getItem('enterpriseSaveFiles');
    driveFullRun();
    expect(localStorage.getItem('enterpriseSaveFiles')).toBe(baseline);
  });

  it('零落盘：自动存档被 demoMode 闸住', () => {
    store().saveGame();
    const baseline = localStorage.getItem('enterpriseSaveFiles');
    driveFullRun();
    // 同样先确认整局真跑完了，否则"没多出帧"可能只是因为一步都没走
    expect(runner().phase).toBe('finished');
    expect(localStorage.getItem('enterpriseSaveFiles')).toBe(baseline);
  });
});

// 结局读数断言在步骤 6 实测跑通后再补——先写好一组没测过的数字就是占位符。
// 注意终局态是 currentYear 5 / currentQuarter 1（store:2928 用 `isGameOver: newYear > 4`，跨年第5年才置真），
// 所以 expand() 靠 isGameOver 先判空队列，绝不能拿 currentYear 去索引 YEAR_INTENTS[5]。

// 这组数字是一次真实跑通的实测读数（不是预测值）。改剧本、改规则都要重测它——
// 它红了先别改期望，看是不是那笔钱真的变了（规格 §10.2：不能反过来放宽测试）。
// 规格 §6 第 2 组要求的三项齐了：现金（cash）、权益（equity + retainedProfit + annualNetProfit）、
// 第 4 年净利（annualNetProfit 在终局态就是第 4 年的年度净利）。
describe('结局读数', () => {
  it('第4年末的现金、权益与 P2 资格', () => {
    driveFullRun();
    const f = store().state.finance;
    expect(f.cash).toBe(8);
    expect(f.equity + f.retainedProfit + f.annualNetProfit).toBe(123);
    expect(f.annualNetProfit).toBe(15);
    // 终局不挂有息负债：第 3 年末初始长贷 40M 本息结清，剧本第 4 年不再申请长贷（规格 §4.4 回写）
    expect(f.loans).toHaveLength(0);
    expect(store().state.production.productRD.P2.completed).toBe(true);
    expect(store().state.operation.currentYear).toBe(5);   // 跨年第5年才置 isGameOver（store:2928）
    expect(store().state.operation.currentQuarter).toBe(1);
  });

  // 规格 §10 第 12 条承诺"整局 94 步 / 15 次选单 / 13 次交货…"由测试锁定——那段测试原先只断 6 项读数、
  // 没有任何 op 计数，所以这一组才是它说的那道守卫（顺带钉住条 11 的"选 15 交 13"）。
  // 同为实测锁定值：同一进程里连续三次整局跑出的逐项计数与总步数完全一致（不是范围、不是约等于）。
  it('整局的动作计数（剧本长什么样，逐步为证）', () => {
    const counts: OpCounts = {};
    driveFullRun(counts);
    expect(runner().phase).toBe('finished');
    expect(counts).toEqual({
      payTaxes: 3,
      placeAdvertisement: 4,
      enterOrderMeeting: 4,
      selectOrder: 15,
      applyShortTermLoan: 3,
      discountReceivable: 6,
      placeRawMaterialOrder: 16,
      addProductionLine: 1,
      startProduction: 1,
      deliverOrder: 13,
      investProductR_D: 1,
      investMarketDevelopment: 10,
      investISOCertification: 1,
      nextQuarter: 16,
    });
    // 94 步 = 上面各项之和；写死它，免得有人新增一种 op 把总数推进去却没人注意
    expect(Object.keys(counts).reduce((sum, k) => sum + counts[k], 0)).toBe(94);
  });
});

describe('runner 的撞门与补选', () => {
  it('订货会之后才补出的选单步：第1年真选到 3 张单', () => {
    // 季初那次 expand() 面对的是空池（池由 enterOrderMeeting 现场生成），选单必然为零；
    // 补选没接上时这条用例红在"0 张"，而不是红在某笔钱。
    withStepClock(() => {
      runner().start();
      for (let i = 0; i < 40; i++) {
        const r = runner();
        if (r.phase !== 'paused' && r.phase !== 'idle') break;
        const head = r.queue[0];
        runner().step();
        if (head?.op.kind === 'nextQuarter') break;   // 跑完第1年第1季
      }
    });
    expect(runner().phase).not.toBe('blocked');
    expect(store().state.marketing.selectedOrders).toHaveLength(3);   // YEAR_INTENTS[1].orderCap = 3
  });

  it('撞门：引用没变就停，队列把这一步留着供重试', () => {
    withStepClock(() => {
      runner().start();
      // 凭空塞一步池子里不存在的交货：dispatch 命中 store:2052 的静默守卫（`return state`）
      useDemoRunner.setState({
        queue: [{ stepId: 'q-14', op: { kind: 'deliverOrder', orderId: 'order-does-not-exist' },
          name: '按订单交货', label: '按订单交货（伪造）', isPausePoint: false }],
      });
      runner().step();
    });
    const r = runner();
    expect(r.phase).toBe('blocked');
    expect(r.blocked?.reason).toContain('静默守卫');
    expect(r.queue[0]?.op.kind).toBe('deliverOrder');   // "重试此步"有的可重
  });

  it('skipQuarter 一次越过一整季，停在下一季季初', () => {
    withStepClock(() => {
      runner().start();
      runner().skipQuarter();
    });
    const op = store().state.operation;
    expect(op.currentQuarter).toBe(2);      // 第1年第1季 → 第1年第2季
    expect(runner().phase).not.toBe('blocked');
    expect(runner().queue.length).toBeGreaterThan(0);   // 新一季已展开
  });
});

// ===== Task 7 审查发现：runner 状态机没闭合的三处 + 讲解卡的一格错位 + 同步批量的 id 撞车 =====

describe('restart 真的重开一局（审查修 1，关键）', () => {
  it('restart 先退演示再重进：回到第1年第1季的开局态，广告不会被扣第二次', () => {
    withStepClock(() => {
      runner().start();
      // 走完第 1 年第 1 季（含 nextQuarter），此刻站在第 1 年第 2 季、广告已投过 1 次
      for (let i = 0; i < 40 && store().state.operation.currentQuarter === 1; i++) runner().step();
      expect(store().state.operation.currentQuarter).toBe(2);
      runner().restart();

      // restart 只调 start() 的话 enterDemo 幂等早退（store:551 的守卫，Task 1 有测试钉着），
      // 于是"重开"变成对当前半年季重跑 decideQuarter：年季不动、现金还是花了钱的那个数。
      const op = store().state.operation;
      expect(op.currentYear).toBe(1);
      expect(op.currentQuarter).toBe(1);
      expect(store().state.finance.cash).toBe(20);   // createFreshState 的开局现金
      // 新一局的年初段重走一遍：广告只有一份（老写法在这里再扣 2M、并整替订单池）
      runner().skipQuarter();
    });
    expect(store().state.marketing.advertisements).toHaveLength(1);
    expect(store().state.marketing.selectedOrders.length).toBeGreaterThan(0);
  });
});

describe('blocked 的收尾（审查修 2）', () => {
  it('重试成功后相位从 blocked 回到 paused，blocked 清空', () => {
    withStepClock(() => {
      runner().start();
      // 队列首位换成一条注定被拒的步：池子里没有这个 id 的交货 → dispatch 空操作 → blocked
      useDemoRunner.setState({ queue: [mkStep('q-14', { kind: 'deliverOrder', orderId: 'order-ghost' })] });
      runner().step();
      expect(runner().phase).toBe('blocked');
      // 「重试此步」：把首位换成一条真走得通的步（交税，年初现成能过），执行成功
      useDemoRunner.setState({ queue: [mkStep('b-4', { kind: 'payTaxes' })] });
      runner().step();
    });
    // 被拒时置的 blocked 相位必须跟着回来，否则 skipQuarter(:232) 一直早退、面板显示"被拒但报错区已空"
    expect(runner().blocked).toBeNull();
    expect(runner().phase).toBe('paused');
  });
});

describe('skipQuarter 的相位（审查修 3）', () => {
  it('播放中跳到下一季不会留下一个没有 timer 的 playing', () => {
    withStepClock(() => {
      runner().start();
      // 队列只放**非讲解点**的步：讲解点会把相位自己落回 paused，那样这条就只是被顺带修好了，
      // 测不到"playing 但没有 timer"这个真状态。
      useDemoRunner.setState({
        queue: [
          mkStep('q-6', { kind: 'placeRawMaterialOrder', materialType: 'R1', quantity: 1 }),
          mkStep('q-20', { kind: 'nextQuarter' }),
        ],
      });
      runner().play();                       // playing + 一个 600ms 后才响的 timer（测试里不会响）
      runner().skipQuarter();                // 同步批量跑完整季：timer 清了，相位必须跟着清
    });
    // 停在 playing 却没有 timer 时 play() 首行(:214)早退 → 面板显示"播放中"却一步都走不了
    expect(runner().phase).not.toBe('playing');
    expect(runner().phase).toBe('paused');
  });
});

describe('季初 selectOrder 步的丢弃（审查修 4）', () => {
  it('订货会整替订单池：季初那批步无条件丢弃，补选为空也不留失效 id', () => {
    withStepClock(() => {
      runner().start();
      // 造出实测每年都发生的形态：季初算出一批 selectOrder（对着当时的池子），
      // 而 enterOrderMeeting 每次都整替订单池（store:1791）→ 那些 id 必然失效。
      // 补选这轮挑不到单（广告额 0 → unlocked 0 → 新池为空），老写法会把废步留在队列里，
      // dispatch 撞 store:2029「该订单不在可选列表中」当场 blocked。
      useDemoRunner.setState({
        queue: [
          mkStep('b-2', { kind: 'enterOrderMeeting' }, true),
          mkStep('b-2', { kind: 'selectOrder', orderId: 'order-stale-from-old-pool' }),
          mkStep('q-20', { kind: 'nextQuarter' }),
        ],
      });
      runner().step();                        // 只走订货会这一步，看补选后剩下什么
    });
    expect(runner().queue.some((s) => s.op.kind === 'selectOrder')).toBe(false);
    expect(runner().phase).not.toBe('blocked');
  });
});

describe('lastStep：刚执行的那一步（审查修 5）', () => {
  it('讲解点触发后 lastStep 是刚执行的那步，queue[0] 已是下一步', () => {
    withStepClock(() => {
      runner().start();
      for (let i = 0; i < 40 && runner().lastStep?.stepId !== 'q-6'; i++) runner().step();
    });
    // Task 8 的讲解卡读 lastStep.rule、进度读 queue.length：runner 若只留 queue[0]，卡片会错一格
    expect(runner().lastStep?.stepId).toBe('q-6');
    expect(runner().queue[0]?.stepId).not.toBe('q-6');
    expect(runner().phase).toBe('paused');    // 讲解点自动停
  });
});
