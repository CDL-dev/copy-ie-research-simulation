// 课堂演示的隔离边界（规格 §4.8）：演示局不得写本机存档列表，退出后当前进度必须逐字段复原。
// roadmap §3 P0 记过一次真实事故——自动化把测试存档写进 localStorage 覆盖了人工存档，本文件是它的反向守卫。
import { beforeEach, describe, expect, it } from 'vitest';
import { createFreshState, useEnterpriseStore } from '../src/store/enterpriseStore';

const store = () => useEnterpriseStore.getState();

const resetStore = () => {
  // demoMode/demoSnapshot 必须一起清：否则上一条用例残留的演示态会让下一条的 autoSaveGame 静默短路
  useEnterpriseStore.setState({
    state: createFreshState(),
    saveFiles: [],
    validationError: null,
    demoMode: false,
    demoSnapshot: null,
  });
  localStorage.removeItem('enterpriseSaveFiles');
};

beforeEach(resetStore);

describe('进出演示的内存隔离', () => {
  it('enterDemo 换到全新局并把暂停态清掉，exitDemo 完整恢复原进度', () => {
    store().discountReceivable(7);        // 现金 20→26，让当前屏与开局态有可观察差异
    store().togglePaused();               // 老师开着讲解模式进演示，暂停态不该被带过去
    const before = JSON.stringify(store().state);

    store().enterDemo();
    expect(store().demoMode).toBe(true);
    expect(store().state.operation.currentYear).toBe(1);
    expect(store().state.operation.currentQuarter).toBe(1);
    expect(store().state.finance.cash).toBe(20);
    expect(store().state.isPaused).toBe(false);

    store().exitDemo();
    expect(store().demoMode).toBe(false);
    expect(store().demoSnapshot).toBeNull();
    expect(JSON.stringify(store().state)).toBe(before);
  });

  it('演示中的季度推进不往 localStorage 塞自动存档帧', async () => {
    store().saveGame();                   // 真落一帧，拿到基线字节
    const baseline = localStorage.getItem('enterpriseSaveFiles');

    store().enterDemo();
    store().nextQuarter();
    await new Promise((resolve) => setTimeout(resolve, 0));   // nextQuarter 的 autoSaveGame 排在 setTimeout(…,0)

    // 必须先确认真推进了：如果 nextQuarter 被别的门挡下，autoSaveGame 根本不会被排，
    // 下面那句"字节不变"就是空跑通过的假绿
    expect(store().state.operation.currentQuarter).toBe(2);
    expect(localStorage.getItem('enterpriseSaveFiles')).toBe(baseline);
    store().exitDemo();
    expect(localStorage.getItem('enterpriseSaveFiles')).toBe(baseline);
  });

  it('exitDemo 在没有快照时不毁掉当前屏', () => {
    const before = JSON.stringify(store().state);
    store().exitDemo();                   // 没进过演示就退出
    expect(JSON.stringify(store().state)).toBe(before);
  });

  it('exitDemo 抢在宏任务队列排空前退出，积压的自动存档一帧也不落盘', async () => {
    // 时序洞：nextQuarter 把 autoSaveGame 排在 setTimeout(…,0) 里，而闸门读的是"执行时刻"的 demoMode。
    // 直接驱动 store 的四年 runner 会同步推完整局再 exitDemo，队列根本没排空过——
    // 只在回调里加闸的话，积压的 N 发会在 demoMode 已为 false 后逐条通过，往老师的存档列表追加 N 帧。
    store().saveGame();                   // 真落一帧，拿到基线字节
    const baseline = localStorage.getItem('enterpriseSaveFiles');

    store().enterDemo();
    store().nextQuarter();                // 排程点 1（不 await）
    store().nextQuarter();                // 排程点 2（不 await）
    // 先确认真推进了两季：否则下面"字节不变"可能只是 nextQuarter 被别的门挡下、根本没排回调的空跑假绿
    expect(store().state.operation.currentQuarter).toBe(3);
    store().exitDemo();                   // 抢在两发回调之前退出

    await new Promise((resolve) => setTimeout(resolve, 0));   // 让积压的宏任务跑完

    expect(store().state.operation.currentQuarter).toBe(1);   // 老师的屏已换回开局态
    expect(localStorage.getItem('enterpriseSaveFiles')).toBe(baseline);
  });

  it('演示态中重复 enterDemo 不会覆盖快照、毁掉老师当前屏', () => {
    // 重入洞：enterDemo 无条件把"当时那一屏"拍成快照。演示态中再次进入（双击、或入口在演示态仍可见）
    // 拍进去的就是演示局的屏，老师原屏只剩内存里被覆盖的引用——没手存过的进度直接没了。
    store().discountReceivable(7);        // 让老师屏与开局态有可观察差异
    const before = JSON.stringify(store().state);

    store().enterDemo();
    store().nextQuarter();                // 演示局推进一季
    store().enterDemo();                  // 重入：修复前会把演示局 Q2 拍成新快照
    store().exitDemo();

    expect(store().demoMode).toBe(false);
    expect(JSON.stringify(store().state)).toBe(before);
  });
});
