// Task 9：能力边界文案的单源约束（规格 §4.6 / 计划 Task 9）。
// 这句话要在三个地方出现——核对报告首行、规则弹窗、README。任何一处自己再打一遍，
// 三处就会各自漂走，所以这里比对的**不是相似措辞**，而是**同一个常量对象的引用结果**：
// README 用 fs 真读文件、弹窗用导出的 RULE_SECTIONS，报告侧的同一性已由 tests/audit.test.ts 覆盖。
// 后两组用例只读源码**文本**，不渲染组件（测试环境是 node、无 jsdom，规格 §7）——
// 它们要挡的是"文档写了个界面里根本没有的说法"，而不是行为回归（行为回归在各自的测试文件里）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { INTEGRITY_BOUNDARY, INTEGRITY_CAVEATS, CAUSE_TEXT } from '../src/utils/audit';
import { SAVE_FORMAT_VERSION } from '../src/types/enterprise';
import { RULE_SECTIONS, ruleTextFor } from '../src/components/RulesModal';
// Task 6：剧本是纯数据，它对规则弹窗与运行控制表的引用是**跨文件的位置型键**，
// 这三份数据各改各的都不会有编译错——只有这里的守卫能让它当场变红。
// ruleTextFor 已在上面那行引入，ESM 下同名绑定重复声明直接报错，不再写第二遍。
import { PAUSE_POINTS, YEAR_INTENTS } from '../src/demo/script';
// 剧本的新线要对着**开局状态**查配额（生产线类型余量），所以这里引入状态工厂而非读源码文本
import { createFreshState } from '../src/store/enterpriseStore';
import { CONTROL_STEPS } from '../src/utils/controlTable';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
// 文档里的操作路径按 markdown 习惯给每段加反引号，比对"路径是否真写了这两级"时先把反引号剥掉，
// 免得断言绑死排版；能力边界那句仍用**原样** readme 比对（那句要求逐字，含标点）。
const readmePlain = readme.replace(/`/g, '');
const panelSrc = readFileSync(new URL('../src/components/SaveLoadPanel.tsx', import.meta.url), 'utf8');
const modalSrc = readFileSync(new URL('../src/components/RulesModal.tsx', import.meta.url), 'utf8');
const storeSrc = readFileSync(new URL('../src/store/enterpriseStore.ts', import.meta.url), 'utf8');
const auditSrc = readFileSync(new URL('../src/utils/audit.ts', import.meta.url), 'utf8');

const SAVE_SECTION = '存档与完整性校验';
const sectionItems = (): string[] => {
  const section = RULE_SECTIONS.find((s) => s.title === SAVE_SECTION);
  expect(section).toBeDefined();
  return section!.items;
};

describe('能力边界文案：三处同一句（Task 9）', () => {
  it('README 逐字含边界句与两条余地', () => {
    expect(readme).toContain(INTEGRITY_BOUNDARY);
    INTEGRITY_CAVEATS.forEach((caveat) => expect(readme).toContain(caveat));
  });

  it('规则弹窗里的是**同一个常量**（引用相等，重打同字面量过不了）', () => {
    const items = sectionItems();
    expect(items.filter((i) => i === INTEGRITY_BOUNDARY)).toHaveLength(1);
    INTEGRITY_CAVEATS.forEach((caveat) => {
      expect(items.filter((i) => i === caveat)).toHaveLength(1);
    });
  });

  it('弹窗这一节紧跟「融资与资金管理」（计划 Task 9 Step 1 的位置）', () => {
    const i = RULE_SECTIONS.findIndex((s) => s.title === '融资与资金管理');
    expect(i >= 0).toBe(true);
    expect(RULE_SECTIONS[i + 1].title).toBe(SAVE_SECTION);
  });
});

describe('文案不得描述未实现的能力 / 不得自造印面词汇（Task 9）', () => {
  it('README 的版本说法经 SAVE_FORMAT_VERSION，并写明 v3→v4 的载入期换算', () => {
    expect(readme).toContain('SAVE_FORMAT_VERSION');
    expect(readme).toContain(`当前 ${SAVE_FORMAT_VERSION}`);
    expect(readme).toContain('restatement.ts');
    expect(readme).toContain('migrateState');
  });

  it('文档写的操作路径与界面按钮同名', () => {
    expect(readmePlain).toContain('存档管理 → 导出存档包');
    expect(panelSrc).toContain('导出存档包');
    expect(panelSrc).toContain('导入存档包');
    // 弹窗/README 承诺的两条落库动作，按钮文案就是这两句
    expect(panelSrc).toContain('仅加入存档列表');
    expect(panelSrc).toContain('设为当前进度');
  });

  it('「哈希未计算」「-imported-N」「（导入N）」在源码里真存在，不是文档虚构', () => {
    // 复审 item 2：这句措辞从组件搬到 audit.ts（报告也要印同一句，而 util 不能 import .tsx），
    // 所以「真存在」的核对地点随之改成常量所在的那一份源码
    expect(auditSrc).toContain('哈希未计算（非 HTTPS 环境）');
    expect(panelSrc).toContain('digestSkipNote');            // 面板仍在用同一份，只是不再自己写一遍
    expect(storeSrc).toContain('-imported-');
    expect(storeSrc).toContain('（导入${n}）');
    // 暂停态只读豁免：文档若写"暂停时也能导出"，源码得真给这条提示
    expect(panelSrc).toContain('运营已暂停，请先继续运营再导入（导出与预览仍可用）');
  });

  it('对外用审计词汇表里的印面词，不另造一套说法', () => {
    const blob = `${sectionItems().join('\n')}\n${readme}`;
    // CAUSE_TEXT 三值与 formatFrameAudit 的读数名（住在 audit.ts，面板与报告共用）
    expect(auditSrc).toContain('流水重演算');
    Object.keys(CAUSE_TEXT).forEach((key) => expect(blob).toContain(CAUSE_TEXT[key as keyof typeof CAUSE_TEXT]));
    expect(blob).toContain('账实不符');
    expect(blob).toContain('起算链不完整');   // no-anchor 的用户可见说法（audit.ts:184）
    expect(blob).toContain('哈希未计算');
  });

  // 复审 item 4：这句常量现在被三个地方印（报告 / 弹窗 / README）。旧写法在句尾挂着「条数见下方帧统计里的…」，
  // 那是**报告版面**相对的指代——印在弹窗与 README 里指向nothing，Task 9 因此在两处各补了一句自造的
  // 说明文字（症状补丁），句子于是有了第四个、第五个版本。修法是句子本身改成上下文无关的说法，
  // 补丁随之删掉；本例钉住"不许再写方向词"，让补丁没法长回来。
  it('两条余地自带完整含义，不靠版面指代；三处之外不许再加自造的说明句', () => {
    INTEGRITY_CAVEATS.forEach((caveat) => {
      expect(caveat).not.toMatch(/下方|如上|上述|见上|见下/);
    });
    expect(modalSrc).not.toMatch(/下方|见核对报告的帧统计行/);
    expect(readme).not.toMatch(/下方帧统计|其中提到的/);
    // 唯一来源：弹窗与 README 都只能引常量，不能重打句子
    expect(modalSrc).toContain('...INTEGRITY_CAVEATS');
    expect(readme).toContain(INTEGRITY_CAVEATS[0]);
  });
});

// ══ 面板与报告共用同一份实现（复审 items 2 / 3 / 6c）════════════════════════════
// 与上面几例同一套办法：node 环境、无 jsdom（规格 §7），渲染不了组件就核对**渲染要用到的源码**。
describe('面板接线：跨度取审计侧的 packageSpan，报告导出有失败面', () => {
  it('时间跨度用 audit.ts 的 packageSpan，组件里不再留第二份定序', () => {
    expect(auditSrc).toContain('export const packageSpan');
    expect(panelSrc).toContain('packageSpan(');
    // 组件里自己再写一遍 byTimeThenId 循环 = 同毫秒兜底又漂成两份（评审 Task 7 finding 5 的形态）
    expect(panelSrc).not.toMatch(/byTimeThenId\s*\(/);
  });

  it('handleExportReport 与存档包导出同级：build 与 download 都在 try 里，原因用 error.message', () => {
    const body = /const handleExportReport[\s\S]*?\n  \};/.exec(panelSrc);
    expect(body).not.toBeNull();
    const src = body![0];
    expect(src).toContain('try {');
    expect(src).toContain('} catch');
    expect(src).toContain('setValidationError(');
    // Task 5 定的规矩：name 会把中文说明吞掉，能说的是 message
    expect(src).toContain('error.message');
    expect(src).not.toContain('error.name');
    expect(src).toContain('downloadFile(');
  });
});

describe('规则条目可被讲解点稳定引用（演示模式规格 §4.3）', () => {
  it('每个 section 有非空唯一 id，且节顺序与标题不变', () => {
    const ids = RULE_SECTIONS.map((s) => s.id);
    expect(RULE_SECTIONS).toHaveLength(10);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toBeTruthy());
    // id 的取值与顺序必须逐字钉死：只钉唯一性的话，把 finance 和 save 互换测试全绿，
    // 但 ruleTextFor({section:'finance'}) 会静默印出另一节的原文（规格 §4.3）。
    // 与下面的 title 数组断言配对，同时钉死 id 顺序与 id↔title 对应关系。
    expect(ids).toEqual([
      'ad', 'market', 'orders', 'factory', 'production',
      'rd-iso', 'finance', 'save', 'cost', 'time',
    ]);
    expect(RULE_SECTIONS.map((s) => s.title)).toEqual([
      '广告投放规则（本系统修改项）', '市场开发与准入', '销售会议与订单争取', '厂房与生产线',
      '采购与生产', '产品研发与ISO认证', '融资与资金管理', '存档与完整性校验',
      '费用、折旧与税金', '运营时间',
    ]);
  });

  it('ruleTextFor 取到原文，越界返回 null 而不是崩或印 undefined', () => {
    expect(ruleTextFor({ section: 'ad', item: 0 })).toBe(RULE_SECTIONS[0].items[0]);
    expect(ruleTextFor({ section: 'ad', item: -1 })).toBeNull();
    expect(ruleTextFor({ section: 'ad', item: 999 })).toBeNull();
    expect(ruleTextFor({ section: 'nope', item: 0 })).toBeNull();
  });
});

// ══ 演示剧本引用的键必须真实存在（Task 6，规格 §4.3/§4.4）═══════════════════════
describe('演示剧本引用的都是真实存在的东西（演示模式规格 §4.3/§4.4）', () => {
  it('讲解点的 stepId 两两不同（重复的第二条经 pausePointFor 永不可达）', () => {
    // pausePointFor 用 find：若表里混进同 stepId 的两条，第二条静默失效——面板停不下、也不报错。
    // 这条断言就是 script.ts 注释里那句"自己数一遍"的替代网（Task 7 补）。
    const ids = PAUSE_POINTS.map((p) => p.stepId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每个讲解点的 stepId 都在 CONTROL_STEPS 里', () => {
    const ids = new Set(CONTROL_STEPS.map((s) => s.id));
    PAUSE_POINTS.forEach((p) => expect(ids.has(p.stepId)).toBe(true));
  });

  it('每个讲解点取回的原文含该步该有的关键词（只断非 null 会放行"指对节、指错条目"）', () => {
    // 关键词是从 RULE_SECTIONS 的实际文字里挑出来的独词，不是随便一个高频字
    const KEYWORD: Record<string, string> = {
      'b-4': '所得税', 'q-17': '解锁', 'b-2': '订单池', 'q-3': '短期贷款',
      'q-6': '提前', 'q-10': '加工费', 'q-8': '安装', 'q-14': '账期',
      'q-11': '贴现', 'q-15': 'P2', 'e-1': '长期贷款', 'e-5': '市场开拓投资',
    };
    PAUSE_POINTS.forEach((p) => {
      const text = ruleTextFor(p.rule);
      expect(text).not.toBeNull();
      // 失败时打印的是 received 整条原文，配合上一行的 not.toBeNull 足以定位到哪一步指错了条目
      expect(text).toContain(KEYWORD[p.stepId]);
    });
  });

  it('四年意图齐备且金额非负、市场投资含本地维持', () => {
    ([1, 2, 3, 4] as const).forEach((y) => {
      const it = YEAR_INTENTS[y];
      expect(it.year).toBe(y);
      expect(it.adAmount).toBeGreaterThan(0);
      expect(it.cashPad).toBeGreaterThan(0);
    });
    // 已准入市场每年投 1M 维持，否则丧失准入（store:2798 第2年起判）
    ([2, 3, 4] as const).forEach((y) => expect(YEAR_INTENTS[y].marketInvest).toContain('local'));
  });

  it('剧本声明的新线在引擎配额内真建得出来（Task 7 实测校正）', () => {
    // 原用例断"剧本只声明全自动线"，理由是慢线会让产能/投料两处折算失真。
    // Task 7 第一次真跑把前提推翻了：`productionLineLimits.automatic = 2`（store:51-56）而开局
    // 两条全自动线已在（line-1/line-2），配额从第 1 年起就是 0 剩——声明 automatic 只会撞
    // store:925-932 的静默空操作，整局在第 2 年第 1 季停住。
    // 「折算失真」那一半当时说得不准，按实情更正（Task 7 审查修 8）：两处折算**方向相反**，
    // 都不是"错"，但绝不是"都偏保守侧"——
    // ① 备料侧 `quarterlyMaterialDemand`（decide.ts:90-95）用 Math.ceil：半自动线每季记 1 套料，
    //    而引擎每两季才吃一套 → 多买约一季的料、多压几 M 现金，这半边才是保守侧。
    // ② 产能侧 `commitableUnits`（decide.ts:36-39）用 `inProgressProducts + Math.floor(quartersLeft / period)`
    //    滚动折算，而引擎按 `line.type` + **日历季奇偶**出货（store:2458-2467，半自动是 `shouldComplete = newQuarter % 2 === 0`，
    //    `newQuarter` 是年内季度号 :2176，所以一条半自动线每年只在进入第 2、第 4 季时入库，最多 2 件）：
    //    实测（本局采用剧本）该线在第 3 年年初被 decide 记 **3 件**（在制品 1 + floor(4/2)=2），引擎本年只入库 **2 件**，
    //    多承诺 1 件/线/年，选单因此**虚高**——这正是规格 §10 条 11「终局剩 2 张单 / 6 件交不出」的来源之一，不是保守侧。
    //    （第 2 年年初它还是 `installing`，被 PRODUCIBLE_STATUS 白名单记 0，虚高从第 3 年起发作。）
    // 结论不变：真错的是"这条线根本建不出来"，所以守卫换成按开局状态查配额。
    // ② 的折算不同构要修得动 Task 3 的已审实现（commitableUnits），本期不修，已记进规格 §10 条 14。
    const fresh = createFreshState();
    const used = fresh.production.factories.flatMap((f) => f.productionLines);
    ([1, 2, 3, 4] as const).forEach((y) => {
      YEAR_INTENTS[y].newLines.forEach((l) => {
        expect(used.filter((line) => line.type === l.lineType).length)
          .toBeLessThan(fresh.productionLineLimits[l.lineType]);
      });
    });
  });
});
