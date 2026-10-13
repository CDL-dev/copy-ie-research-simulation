// 全速跑完一局（规格 §6 第 2 组）：这条是"剧本与规则不脱钩"的唯一守卫——
// 规则改了剧本失效，它先红。不经 UI，直接驱动 runner 的 step()，所以无 jsdom 也能测。
import { beforeEach, describe, expect, it } from 'vitest';
import { createFreshState, useEnterpriseStore } from '../src/store/enterpriseStore';
import { useDemoRunner } from '../src/demo/runner';

const store = () => useEnterpriseStore.getState();
const runner = () => useDemoRunner.getState();

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

const driveFullRun = () => {
  withStepClock(() => {
    runner().start();
    // 一季最多约 12 步 × 16 季，4000 是宽松上限；撞门会立刻停在 blocked
    for (let i = 0; i < 4000 && runner().phase !== 'finished' && runner().phase !== 'blocked'; i++) runner().step();
  });
  return runner();
};

beforeEach(() => {
  useEnterpriseStore.setState({ state: createFreshState(), saveFiles: [], validationError: null, demoMode: false, demoSnapshot: null });
  useDemoRunner.setState({ phase: 'idle', queue: [], blocked: null });
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
// 注意终局态是 currentYear 5 / currentQuarter 1（store:2892 用 `isGameOver: newYear > 4`，跨年第5年才置真），
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
    expect(store().state.operation.currentYear).toBe(5);   // 跨年第5年才置 isGameOver（store:2892）
    expect(store().state.operation.currentQuarter).toBe(1);
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
