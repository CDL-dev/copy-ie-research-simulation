'use client';
import React, { useEffect, useState } from 'react';
import { useEnterpriseStore } from '../store/enterpriseStore';
import { ruleTextFor } from './RulesModal';
import { useDemoRunner } from '../demo/runner';

/** 抽屉展开宽（规格 §4.7「约 360px，可折叠」）与收起后的窄边宽，只给 title 里那句说明用；
 *  真正的宽度写在 className 上（`w-[360px]` / `w-10`），改这两个数不改 class 不会生效，反之亦然——
 *  page.tsx 那两颗让位外套的 `mr-[360px]` 必须跟着 `w-[360px]` 一起改 */
const PANEL_W = 360;
const RAIL_W = 40;

/**
 * 右侧演示抽屉：只读 runner 的状态，不含任何业务判断（规格 §4.1）。
 * 讲解卡的文字来自 RULE_SECTIONS（条目级引用），这里一个字都不新写。
 *
 * 读数分工钉死在 src/demo/runner.ts 文件头（:4-8，Task 7 复审定的接口）：
 * - **讲解卡读 `lastStep`**（刚成功执行的那一步，它的 rule/label 就是屏幕上该念的那条规则原文）；
 *   **不读 `queue[0]`**——advanceOne 先弹出队首再执行，讲解点自动停的那一刻 `queue[0]` 已经是
 *   下一步，拿它当讲解来源卡片会错一格。
 * - **进度读 `queue.length`**（本季还剩几步）；**年季直接读 store 的 `operation`**。
 * - `queue[0]`（下面的 upcoming）只用来预览"下一步是什么"，那才是它的本义。
 *
 * 让位（Task 8 审查修 B）：抽屉是 `fixed right-0 top-0 z-40`（在流外），页眉 <header> 是 static、
 * 没有 z-index，所以不让位时顶栏右簇（规则说明／暂停运营／存档管理）会整体落进抽屉底下并被吃掉点击。
 * 让位打在 page.tsx 的两颗全宽外套上（页眉一颗、「三条横幅 + main」一颗，同一颗边距 → 两处同轴）；
 * 抽屉收起时外套不跟着缩（折叠状态住在这个组件内部，是界面偏好，不进 runner 也不进 store），
 * 代价是收起后右侧空出一条，换来的是不依赖视口宽度档、也不与主内容错轴。
 */
const DemoPanel: React.FC<{ onOpenRules: () => void }> = ({ onOpenRules }) => {
  const demoMode = useEnterpriseStore((s) => s.demoMode);
  const operation = useEnterpriseStore((s) => s.state.operation);
  // 整块订阅 runner（不挑字段）：queue/phase/blocked 任一变化都重渲染，与 page.tsx:18 同一写法
  const { phase, queue, blocked, lastStep, speedMs, start, step, play, pause, skipQuarter, skipBlocked, restart, exit, setSpeed } = useDemoRunner();
  // 折叠是**界面偏好**，不是演示状态：只住在这个组件里，不进 runner、不进 store（审查修 B 第 2 点）
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    // 非演示态不绑定：老师在正常局里按空格/方向键不该被演示层截走（规格 §4.7）
    if (!demoMode) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // 主界面有原料数量/广告金额等输入框，焦点在输入控件里时绝不劫持按键（规格 §4.7）
      if (el && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); phase === 'playing' ? pause() : play(); }
      // →/Shift+→ 只在非 idle 相位给出口：runner 的 skipQuarter 在 idle 且队列非空时
      // 不会把相位拉出 idle 就直接批量推进（它只在 playing 时落回 paused），step 同理不问相位。
      // 那道情形正常操作走不到（进抽屉必经 start()→paused），但面板不依赖 runner 内部判断兜这层。
      else if (phase !== 'idle' && e.key === 'ArrowRight' && e.shiftKey) { e.preventDefault(); skipQuarter(); }
      else if (phase !== 'idle' && e.key === 'ArrowRight') { e.preventDefault(); step(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [demoMode, phase, play, pause, step, skipQuarter]);

  if (!demoMode) {
    return (
      <button
        onClick={start}
        className="bg-amber-500 text-white text-sm font-medium px-3 py-1 rounded-full hover:bg-amber-600"
        title="自动按剧本走完 4 年，随时可暂停讲解；演示只在内存里跑，不动本机存档"
      >
        课堂演示
      </button>
    );
  }

  const upcoming = queue[0];
  // 讲解卡数据源是 lastStep 而不是 queue[0]，见文件头注释（runner.ts:4-8 的分工）
  const ruleText = lastStep?.rule ? ruleTextFor(lastStep.rule) : null;
  const isPlaying = phase === 'playing';
  // 队列空 = 这一季没有步可走了（终局，或被「跳过此步」跳空的那一格，见 runner.skipBlocked）。
  // 单步与跳到下一季都必须置灰：光在报错区放两个按钮不够，快捷键那条路也得堵住。
  const canWalk = !isPlaying && phase !== 'finished' && queue.length > 0;

  if (collapsed) {
    // 收起态：一条 40px 窄边，只有一个展开钮 + 当前年季（竖排）。
    // 顶栏右簇此时不可能被压——让位外套把整行（含右簇）都推到 W−360 之内，窄边占的是空出来的那一条。
    return (
      <aside
        className="fixed right-0 top-0 z-40 h-full w-10 bg-white shadow-lg border-l border-gray-200 flex flex-col items-center pt-3 gap-2"
        aria-label="课堂演示抽屉（已收起）"
      >
        <button
          onClick={() => setCollapsed(false)}
          className="bg-amber-500 text-white text-xs font-medium px-1 py-2 rounded hover:bg-amber-600"
          title={`展开课堂演示抽屉（约 ${PANEL_W}px）`}
        >
          演示
        </button>
        <div className="text-xs text-amber-700 [writing-mode:vertical-rl] mt-1">
          第{operation.currentYear}年第{operation.currentQuarter}季
        </div>
      </aside>
    );
  }

  return (
    <aside className="fixed right-0 top-0 h-full w-[360px] bg-white shadow-2xl border-l border-gray-200 p-4 overflow-y-auto z-40">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-bold text-gray-800">课堂演示</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCollapsed(true)}
            className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded hover:bg-gray-200"
            title={`收起抽屉（只留出约 ${RAIL_W}px 窄边）；页眉与主内容那两颗让位外套不跟着缩（折叠状态不住在 page.tsx 里），收起后右侧会空出一条`}
          >
            收起
          </button>
          {/* 退出必须走 runner 的 exit()：它 clearTimer() 并把 phase/queue/lastStep/blocked 一起清掉。
              只调 store 的 exitDemo() 会让 runner 留着一指向已恢复真实进度的队列，下一发 step() 就在老师的数据上落子 */}
          <button onClick={exit} className="text-xs bg-red-50 text-red-600 px-2 py-1 rounded hover:bg-red-100">退出演示</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <button onClick={() => (isPlaying ? pause() : play())} className="bg-blue-600 text-white text-sm py-2 rounded hover:bg-blue-700">
          {isPlaying ? '暂停' : '播放'}
        </button>
        <button onClick={step} disabled={!canWalk} className="bg-gray-100 text-gray-800 text-sm py-2 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed">单步</button>
        <button onClick={skipQuarter} disabled={!canWalk} className="bg-gray-100 text-gray-800 text-sm py-2 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed">跳到下一季</button>
        <button onClick={restart} className="bg-gray-100 text-gray-800 text-sm py-2 rounded hover:bg-gray-200 disabled:opacity-50">重新开始</button>
      </div>

      <label className="block text-xs text-gray-500 mb-3">
        速度
        <select
          value={speedMs}
          onChange={(e) => setSpeed(Number(e.target.value))}
          className="ml-2 border border-gray-300 rounded px-1 py-0.5 text-xs"
        >
          <option value={300}>快（300ms/步）</option>
          <option value={600}>中（600ms/步）</option>
          <option value={1200}>慢（1200ms/步）</option>
        </select>
      </label>

      {/* 进度卡：年季读 store 的 operation，剩余步数读 queue.length（runner.ts 文件头的分工） */}
      <div className="bg-gray-50 rounded-lg p-3 mb-3 text-sm">
        <div className="text-gray-500">第{operation.currentYear}年第{operation.currentQuarter}季 · 下一步</div>
        <div className="font-medium text-gray-800">{upcoming ? `${upcoming.name}` : '本局已结束'}</div>
        <div className="text-gray-600">{upcoming?.label ?? ''}</div>
        <div className="text-xs text-gray-400 mt-1">本季还剩 {queue.length} 步（空格＝播放/暂停，→＝单步，Shift+→＝跳季）</div>
      </div>

      {/* 讲解卡：lastStep.rule 经 ruleTextFor 取 RULE_SECTIONS 原文，面板不写任何规则文案（规格 §4.3 单源） */}
      {ruleText && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 mb-3">
          <div className="text-xs font-semibold text-amber-700 mb-1">讲解点 · 刚执行：{lastStep?.name}｜{lastStep?.label}</div>
          <p className="text-sm text-amber-800 leading-relaxed">{ruleText}</p>
          <button onClick={onOpenRules} className="mt-2 text-xs text-amber-700 underline hover:text-amber-900">
            打开规则说明
          </button>
        </div>
      )}

      {blocked && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 mb-3">
          <div className="text-sm font-semibold text-red-700 mb-1">
            第{blocked.year}年第{blocked.quarter}季被拒：{blocked.label}
          </div>
          <p className="text-sm text-red-700 mb-2">{blocked.reason}</p>
          {queue.length > 0 ? (
            <div className="flex gap-2">
              <button onClick={step} className="flex-1 bg-red-600 text-white text-xs py-1.5 rounded hover:bg-red-700">重试此步</button>
              {/* 「跳过此步」走 runner 的 skipBlocked()（修 C）：视图层不许再直接 setState 改队列形状——
                  原先那一句 `queue: s.queue.slice(1)` 能把本季唯一的推进步跳成空队列，
                  下一发单步就撞上 advanceOne 那句"编排层有 bug"，把审计者指向错的模块 */}
              <button onClick={skipBlocked} className="flex-1 bg-white border border-red-300 text-red-700 text-xs py-1.5 rounded hover:bg-red-100">
                跳过此步
              </button>
            </div>
          ) : (
            // 被跳掉的正是本季最后一步（runner.skipBlocked 的队列已空那一格）：这里没有可重试、
            // 也没有可跳的步，再点单步/跳季只是撞假报错，所以两个键都置灰、只给出口。
            <p className="text-xs text-red-600">本季已无步可走：上面的单步与跳到下一季此时不可用，请「重新开始」或退出演示。</p>
          )}
        </div>
      )}

      {phase === 'finished' && (
        <div className="bg-green-50 border border-green-300 rounded-lg p-3 text-sm text-green-700">
          四年运营已跑完。可以点各大中心查看结果、导出运行控制表；退出演示后本机进度自动恢复。
        </div>
      )}
    </aside>
  );
};

export default DemoPanel;
