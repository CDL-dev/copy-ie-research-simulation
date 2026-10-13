// 决策层是纯函数（规格 §4.1：decide 不 import store），所以直接喂状态、读动作描述符。
// 本仓库测试环境是 node、无 jsdom（存档规格 §7），store 级与纯函数级两套都测不了渲染，这里只测数据。
import { describe, expect, it } from 'vitest';
import { createFreshState } from '../src/store/enterpriseStore';
import type { EnterpriseState, Order, ProductionLine, RawMaterialOrder } from '../src/types/enterprise';
import {
  commitableUnits, deliverySteps, materialSteps, pickOrders, productionSteps, quarterlyMaterialDemand,
} from '../src/demo/decide';
import type { YearIntent } from '../src/demo/types';

const intent = (over: Partial<YearIntent> = {}): YearIntent => ({
  year: 1, adAmount: 2, orderCap: 3, newLines: [], rdP2: false,
  marketInvest: [], isoInvest: [], shortLoanQuarters: [], longLoan: false, cashPad: 6, ...over,
});

// totalAmount 由 quantity × unitPrice 推导，不写死常量：deliverOrder 就是拿 totalAmount 记应收
// （enterpriseStore.ts:2072），写死后会出现 `16 件 × 6M` 却 `totalAmount: 10` 的自相矛盾夹具。
// 显式传入的 totalAmount 仍然优先。
const order = (over: Partial<Order> = {}): Order => {
  const base: Order = {
    id: 'o1', productType: 'P1', quantity: 2, unitPrice: 5, totalAmount: 10,
    paymentPeriod: 2, market: 'local', isSelected: false, isDelivered: false, ...over,
  };
  return { ...base, totalAmount: over.totalAmount ?? base.quantity * base.unitPrice };
};

// 复制开局那条在产全自动线再覆写，用来往厂房里塞一条"指定状态 / 指定产品"的线
const lineLike = (s: EnterpriseState, over: Partial<ProductionLine>): ProductionLine => ({
  ...s.production.factories[0].productionLines[0], ...over,
});

describe('选单', () => {
  it('按单价降序取，够不着产能的单跳过而不是硬塞', () => {
    const s = createFreshState();
    s.marketing.availableOrders = [
      order({ id: 'big-unfit', quantity: 16, unitPrice: 6 }),   // 单价最高，但超出本年可承诺量
      order({ id: 'fit-a', quantity: 2, unitPrice: 5 }),
      order({ id: 'fit-b', quantity: 3, unitPrice: 4 }),
    ];
    // 开局可承诺量 = 成品 3 + 两条线（在手各 2 件 + 每季 1 件×4 季）= 15 件，16 件那张必然被跳过
    expect(pickOrders(s, intent({ orderCap: 3 }))).toEqual(['fit-a', 'fit-b']);
  });

  it('orderCap 是硬上限', () => {
    const s = createFreshState();
    s.marketing.availableOrders = [
      order({ id: 'a', quantity: 1 }), order({ id: 'b', quantity: 1 }), order({ id: 'c', quantity: 1 }),
    ];
    s.logistics.finishedProducts = s.logistics.finishedProducts.map((p) => ({ ...p, quantity: 50 }));
    // 三张参数全同、只靠 sort 稳定性区分不开，所以钉住实际选中的 id：上限截断取的必须是靠前的两张
    expect(pickOrders(s, intent({ orderCap: 2 }))).toEqual(['a', 'b']);
  });

  it('已承诺未交的量从可承诺量里扣', () => {
    const s = createFreshState();
    const free = commitableUnits(s, 'P1');
    s.marketing.selectedOrders = [order({ id: 'taken', quantity: 2 })];
    expect(commitableUnits(s, 'P1')).toBe(free - 2);
  });

  it('安装中的线不计入产能：只有 running / idle / stopped 能当季产出', () => {
    const s = createFreshState();
    // line-1：开局那条在产全自动 P1 线，productionPeriod 1、在手在制品 2
    const line = s.production.factories[0].productionLines[0];
    const withRunning = commitableUnits(s, 'P1');

    // 参照值不硬写：把这条线整条撤出 P1 产能再算一次，差值就是它单条贡献的量
    line.product = null;
    const withoutLine = commitableUnits(s, 'P1');
    const contributed = withRunning - withoutLine;
    expect(contributed).toBeGreaterThan(0);   // 贡献为 0 的话下面的断言会空转，先钉住
    line.product = 'P1';

    // 剧本第 2 年那条新全自动 P1 线：addProductionLine 当场把 product 设好、status 'installing'、
    // 在制品 0（enterpriseStore.ts:985-997），但安装期 4 季 → 本年产出 0 件。
    // 按余量记 contributed 件就是凭空产能，pickOrders 会据此多承诺本年根本交不出的单。
    for (const status of ['installing', 'converting', 'maintaining', 'selling'] as const) {
      line.status = status;
      expect(commitableUnits(s, 'P1')).toBe(withRunning - contributed);
    }
    // idle（空闲可开）与 stopped（缺料停产、料齐自动复工）当季还能产出，照旧计入
    for (const status of ['idle', 'stopped'] as const) {
      line.status = status;
      expect(commitableUnits(s, 'P1')).toBe(withRunning);
    }
  });

  it('P1 与 P2 分池算可承诺量：P1 挤占不影响 P2 入选', () => {
    const s = createFreshState();
    // 开局没有 P2 线，塞一条在产全自动 P2 线：在手 2 件 + 每季 1 件 × 4 季 = P2 池 6 件
    s.production.factories[0].productionLines.push(lineLike(s, { id: 'line-p2', product: 'P2' }));
    s.marketing.availableOrders = [
      order({ id: 'p1-big', quantity: 13, unitPrice: 6 }),                       // P1 池 15 → 剩 2
      order({ id: 'p1-rest', quantity: 3, unitPrice: 5 }),                       // 2 < 3 → 跳过
      order({ id: 'p2-full', productType: 'P2', quantity: 6, unitPrice: 4 }),    // P2 池独立 → 入选
      order({ id: 'p2-rest', productType: 'P2', quantity: 1, unitPrice: 3 }),    // P2 池见底 → 跳过
    ];
    expect(pickOrders(s, intent({ orderCap: 4 }))).toEqual(['p1-big', 'p2-full']);
  });

  it('P3 / P4 的单直接跳过（本期不引入 P3/P4 运营入口），且不占 orderCap 额度', () => {
    const s = createFreshState();
    // 塞一条在产 P2 线，让 P1/P2 各有一张真选得动的单
    s.production.factories[0].productionLines.push(lineLike(s, { id: 'line-p2', product: 'P2' }));
    // 单价降序后 P3/P4 排在最前：它们一旦占额度，cap 2 就会把后面两张能落的单挤掉
    s.marketing.availableOrders = [
      order({ id: 'p3', productType: 'P3', quantity: 1, unitPrice: 9 }),
      order({ id: 'p4', productType: 'P4', quantity: 1, unitPrice: 8 }),
      order({ id: 'p1', quantity: 1, unitPrice: 5 }),
      order({ id: 'p2', productType: 'P2', quantity: 1, unitPrice: 4 }),
    ];
    expect(pickOrders(s, intent({ orderCap: 2 }))).toEqual(['p1', 'p2']);
  });
});

describe('交货', () => {
  it('库存够的未交单才生成 deliverOrder 步', () => {
    const s = createFreshState();   // 开局 P1 成品 3 个
    s.marketing.selectedOrders = [
      order({ id: 'can', quantity: 3 }),
      order({ id: 'cant', quantity: 4 }),
      order({ id: 'done', quantity: 1, isDelivered: true }),
    ];
    expect(deliverySteps(s).map((d) => d.op)).toEqual([{ kind: 'deliverOrder', orderId: 'can' }]);
    expect(deliverySteps(s)[0].stepId).toBe('q-14');
  });

  it('同批交货步按库存累减：各自够但合计超库存的两张单只生成一步', () => {
    const s = createFreshState();   // P1 成品 3 件
    // 两张各自 ≤ 库存、合计 4 > 3（orderCap 默认 3 张，这是常见形态）。第一张交完 store 就扣库存
    // （enterpriseStore.ts:2064-2068），第二张必然撞「成品库存不足」（enterpriseStore.ts:2054-2056）。
    s.marketing.selectedOrders = [order({ id: 'first', quantity: 2 }), order({ id: 'second', quantity: 2 })];
    expect(deliverySteps(s).map((d) => d.op)).toEqual([{ kind: 'deliverOrder', orderId: 'first' }]);

    // 累减不等于"一旦超了就整批拒"：扣完还剩 1 件，后面那张 1 件的单照样该生成
    const t = createFreshState();
    t.marketing.selectedOrders = [
      order({ id: 'first', quantity: 2 }),
      order({ id: 'too-big', quantity: 2 }),
      order({ id: 'fits-rest', quantity: 1 }),
    ];
    expect(deliverySteps(t).map((d) => d.op)).toEqual([
      { kind: 'deliverOrder', orderId: 'first' },
      { kind: 'deliverOrder', orderId: 'fits-rest' },
    ]);
  });
});

describe('投料与开工', () => {
  it('每季投料需求按各线产品 BOM 汇总', () => {
    const s = createFreshState();   // 两条全自动线都在产 P1（P1 = 1×R1）
    expect(quarterlyMaterialDemand(s)).toEqual({ R1: 2, R2: 0, R3: 0, R4: 0 });
  });

  // 慢线（半自动 productionPeriod 2、手工 3，见 enterpriseStore.ts:946-965）一个生产周期只投一套 BOM，
  // 每季需求必须按周期折算，否则 materialSteps 按高水位多买、多压的是 1M/个的料款（store:1552）。
  // 取整方向只向上：少算的那一季线会整季停产，比多备一季的钱严重得多。
  it('投料需求按 productionPeriod 折算：一周期一套料，取整只向上', () => {
    const s = createFreshState();
    const slow = s.production.factories[0].productionLines[0];   // line-1，本用例的唯一变量
    // 挂 P3（2×R2 + 1×R3）而不是 P1：P1/P2 的 BOM 每一项都是 1，ceil(1/N) 恒等于 1，
    // 折算在只跑全自动 P1/P2 的当前剧本里根本体现不出来，必须借 qty ≥ 2 的料项才能观察差额。
    slow.product = 'P3';
    slow.productionPeriod = 1;                       // 参照：周期 1 季 = 每季吃掉整套
    const perCycle = quarterlyMaterialDemand(s);
    slow.productionPeriod = 2;                       // 半自动：2 季一周期
    const folded = quarterlyMaterialDemand(s);
    // line-2 是全自动 P1、全程没动，所以 R2 这一项完全来自 line-1：改前/改后两次调用求差
    expect(perCycle.R2).toBe(2);
    expect(folded.R2).toBe(1);
    expect(perCycle.R2 - folded.R2).toBe(1);

    slow.productionPeriod = 3;                       // 手工线：3 季一周期
    const manual = quarterlyMaterialDemand(s);
    expect(manual.R2).toBe(1);   // ceil(2/3) = 1——写成 floor 就是 0，等于让这条线整季停产
    expect(manual.R3).toBe(1);   // ceil(1/3) = 1，同理

    // 反向钉住：全自动线（productionPeriod 1）折算后必须与折算前逐字相同，现有用例才不用改期望值。
    // 也是"P1 这类 qty=1 的 BOM 项即使挂到慢线上也不会被少算"这条保证的落点。
    slow.product = 'P1';
    slow.productionPeriod = 2;
    expect(quarterlyMaterialDemand(s)).toEqual({ R1: 2, R2: 0, R3: 0, R4: 0 });
  });

  it('R1 提前 1 季到货：缺口 = 需求×(提前期+1) − 在手 − 在途', () => {
    const s = createFreshState();   // 在手 R1 3 个、无在途、每季需 2 → 覆盖 2 季要 4
    expect(materialSteps(s)).toEqual([
      { stepId: 'q-6', op: { kind: 'placeRawMaterialOrder', materialType: 'R1', quantity: 1 } },
    ]);
  });

  it('库存够两季以上就不下单', () => {
    const s = createFreshState();
    s.logistics.rawMaterials = s.logistics.rawMaterials.map((m) =>
      m.type === 'R1' ? { ...m, quantity: 9 } : m);
    expect(materialSteps(s)).toEqual([]);
  });

  // 在途必须从缺口里扣，否则每季度都会把同一批料再下一遍；且只扣同一种料——R2 的单子填不了 R1 的坑
  it('在途单抵缺口：同种料抵得掉，别种料抵不掉', () => {
    const s = createFreshState();   // 缺口 = 2×(1+1) − 3 − 0 = 1
    const r2Order: RawMaterialOrder = {
      id: 'rmo-r2', materialType: 'R2', quantity: 1, price: 1, orderPeriod: 1, arrivalPeriod: 2,
    };
    s.logistics.rawMaterialOrders.push(r2Order);
    expect(materialSteps(s)).toEqual([
      { stepId: 'q-6', op: { kind: 'placeRawMaterialOrder', materialType: 'R1', quantity: 1 } },
    ]);
    const r1Order: RawMaterialOrder = { ...r2Order, id: 'rmo-r1', materialType: 'R1' };
    s.logistics.rawMaterialOrders.push(r1Order);
    expect(materialSteps(s)).toEqual([]);   // 1 个在途正好抵掉 1 的缺口
  });

  it('开工只挑料齐且空闲的线', () => {
    const s = createFreshState();
    s.logistics.rawMaterials = s.logistics.rawMaterials.map((m) =>
      m.type === 'R1' ? { ...m, quantity: 1 } : m);
    // 开局两条线都在生产中（各压 2 件在制品），把线 2 腾空闲着——1 个 R1 只够它开工
    s.production.factories[1].productionLines[0].inProgressProducts = 0;
    expect(productionSteps(s, intent())).toEqual([
      { stepId: 'q-10', op: { kind: 'startProduction', lineId: 'line-2' } },
    ]);
  });

  // 开工侧只看 PRODUCIBLE_STATUS 白名单（裁定 1）：料齐与否不是唯一门槛，
  // installing/converting/maintaining 的线本季不产出。这里没有 store 兜底——startProduction
  // （enterpriseStore.ts:1263-1290）不校验 status，只查 product / 在制品 / 料 / 现金，
  // 漏进白名单的状态会被静默改成 running（:1303）并扣走 1 套 BOM + 1M 加工费：
  // 既没有 validationError，runner 也不会停。所以状态门槛只能由决策层自己守住。
  it('料齐但状态不在白名单的线不开工，idle 的照开', () => {
    const s = createFreshState();
    s.logistics.rawMaterials = s.logistics.rawMaterials.map((m) =>
      m.type === 'R1' ? { ...m, quantity: 9 } : m);   // 料齐：让状态成为唯一变量
    s.production.factories[0].productionLines[0].inProgressProducts = 0;
    s.production.factories[1].productionLines[0].inProgressProducts = 0;
    s.production.factories[1].productionLines[0].status = 'idle';   // idle 也在白名单里
    for (const status of ['installing', 'converting', 'maintaining'] as const) {
      s.production.factories[0].productionLines.push(
        lineLike(s, { id: `line-${status}`, status, inProgressProducts: 0 }),
      );
    }
    expect(productionSteps(s, intent())).toEqual([
      { stepId: 'q-10', op: { kind: 'startProduction', lineId: 'line-1' } },
      { stepId: 'q-10', op: { kind: 'startProduction', lineId: 'line-2' } },
    ]);
  });

  it('newLines 每季最多落一条，当年在建数已达上限就不再落', () => {
    const s = createFreshState();
    const withPlan = intent({ newLines: [{ factoryId: 'factory-1', lineType: 'automatic', product: 'P1' }] });
    expect(productionSteps(s, withPlan)[0].op).toEqual({
      kind: 'addProductionLine', factoryId: 'factory-1', lineType: 'automatic', product: 'P1',
    });
    s.production.factories[0].productionLines.push({
      ...s.production.factories[0].productionLines[0],
      id: 'line-new-1', status: 'installing', builtInYear: 1, inProgressProducts: 0,
    });
    expect(productionSteps(s, withPlan).some((d) => d.stepId === 'q-8')).toBe(false);
  });
});
