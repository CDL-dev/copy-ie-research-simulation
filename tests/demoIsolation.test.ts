// 课堂演示的隔离边界（规格 §4.8）：演示局不得写本机存档列表，退出后当前进度必须逐字段复原。
// roadmap §3 P0 记过一次真实事故——自动化把测试存档写进 localStorage 覆盖了人工存档，本文件是它的反向守卫。
import { beforeEach, describe, expect, it } from 'vitest';
import { createFreshState, useEnterpriseStore } from '../src/store/enterpriseStore';

const store = () => useEnterpriseStore.getState();

const resetStore = () => {
  useEnterpriseStore.setState({ state: createFreshState(), saveFiles: [], validationError: null });
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
});
