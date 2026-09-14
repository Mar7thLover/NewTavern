/**
 * 时间态测试（契约 §1.3）：sticky → cooldown 状态机跨多轮、delay、dryRun 不推进、分支不推进。
 * 换算约定见 timed.ts 顶部注释：state 里存「剩余消息数」+ 写入时的 messageCount。
 */

import { describe, expect, it } from 'vitest';

import { type WITimedState } from './types.js';
import {
  activatedIds,
  makeBook,
  makeEntry,
  rejectionOf,
  runScan,
  userMessage,
} from './test-helpers.js';

/** 一个完整回合（用户 + 助手）让可见历史 +2，与 ST 的 chat.length 推进一致 */
const turn = (n: number) => Array.from({ length: n }, (_, i) => userMessage(`message ${i}`));

describe('sticky / cooldown 状态机', () => {
  const books = [
    makeBook([makeEntry({ id: 'e1', keys: ['trigger'], sticky: 3, cooldown: 4, order: 100 })]),
  ];

  it('跨四轮：键激活 → sticky 续命 → sticky 结束转 cooldown → cooldown 压制', () => {
    // 第 1 轮：命中键激活；sticky 与 cooldown 同时挂上（ST setTimedEffects 两种都设）
    const round1 = runScan({
      books,
      history: [userMessage('hello'), userMessage('trigger')],
      state: null,
    });
    expect(activatedIds(round1)).toEqual(['e1']);
    expect(round1.activations[0]?.reason).toBe('key');
    expect(round1.newState).toEqual({ sticky: { e1: 3 }, cooldown: { e1: 4 }, messageCount: 2 });

    // 第 2 轮：历史 +2，键已不在缓冲里，靠 sticky 继续激活（剩余 3-2=1）
    const round2 = runScan({
      books,
      history: turn(4),
      state: round1.newState,
    });
    expect(activatedIds(round2)).toEqual(['e1']);
    expect(round2.activations[0]?.reason).toBe('sticky');
    expect(round2.newState).toEqual({ sticky: { e1: 1 }, cooldown: { e1: 2 }, messageCount: 4 });

    // 第 3 轮：sticky 剩余 1-2 <= 0 结束，立刻转入新的 cooldown（ST onEnded sticky）
    const round3 = runScan({
      books,
      history: [...turn(5), userMessage('trigger')],
      state: round2.newState,
    });
    expect(activatedIds(round3)).toEqual([]);
    expect(rejectionOf(round3, 'e1')).toEqual(['cooldown']);
    expect(round3.newState).toEqual({ sticky: {}, cooldown: { e1: 4 }, messageCount: 6 });

    // 第 4 轮：cooldown 仍有剩余，键命中也被压制
    const round4 = runScan({
      books,
      history: [...turn(7), userMessage('trigger')],
      state: round3.newState,
    });
    expect(activatedIds(round4)).toEqual([]);
    expect(round4.newState.cooldown).toEqual({ e1: 2 });

    // 第 5、6 轮：cooldown 归零后可以重新被键激活
    const round5 = runScan({
      books,
      history: [...turn(9), userMessage('nothing')],
      state: round4.newState,
    });
    expect(round5.newState.cooldown).toEqual({});
    const round6 = runScan({
      books,
      history: [...turn(11), userMessage('trigger')],
      state: round5.newState,
    });
    expect(activatedIds(round6)).toEqual(['e1']);
  });

  it('sticky 期间不重摇概率', () => {
    const sticky = [
      makeBook([
        makeEntry({
          id: 'e1',
          keys: ['trigger'],
          sticky: 4,
          useProbability: true,
          probability: 1,
        }),
      ]),
    ];
    const state: WITimedState = { sticky: { e1: 4 }, cooldown: {}, messageCount: 0 };
    // random 恒为 0.99 → 概率检查必败，但 sticky 条目跳过检查
    expect(
      activatedIds(runScan({ books: sticky, history: turn(2), state, random: () => 0.99 })),
    ).toEqual(['e1']);
  });

  it('swipe / 分支重扫时消息数没有前进，时间态原地不动', () => {
    const state: WITimedState = { sticky: { e1: 3 }, cooldown: { e1: 4 }, messageCount: 2 };
    const result = runScan({ books, history: turn(2), state });
    expect(activatedIds(result)).toEqual(['e1']);
    expect(result.newState).toEqual({ sticky: { e1: 3 }, cooldown: { e1: 4 }, messageCount: 2 });
  });

  it('条目取消 sticky 配置后旧状态被丢弃', () => {
    const plain = [makeBook([makeEntry({ id: 'e1', keys: ['trigger'] })])];
    const state: WITimedState = { sticky: { e1: 3 }, cooldown: {}, messageCount: 0 };
    const result = runScan({ books: plain, history: turn(2), state });
    expect(activatedIds(result)).toEqual([]);
    expect(result.newState.sticky).toEqual({});
  });

  it('条目暂时不在书里时只保留计时，不激活', () => {
    const state: WITimedState = { sticky: { gone: 5 }, cooldown: {}, messageCount: 0 };
    const result = runScan({ books, history: turn(2), state });
    expect(result.newState.sticky).toEqual({ gone: 3 });
  });

  it('dryRun 不推进状态', () => {
    const state: WITimedState = { sticky: { e1: 3 }, cooldown: {}, messageCount: 0 };
    const result = runScan({ books, history: turn(4), state, dryRun: true });
    // 判定照常进行（与真实生成一致），只是不写回
    expect(activatedIds(result)).toEqual([]);
    expect(result.newState).toEqual(state);
  });

  it('dryRun 下新激活的条目也不写入状态', () => {
    const result = runScan({
      books,
      history: [userMessage('trigger')],
      state: null,
      dryRun: true,
    });
    expect(activatedIds(result)).toEqual(['e1']);
    expect(result.newState).toEqual({ sticky: {}, cooldown: {}, messageCount: 1 });
  });
});

describe('delay', () => {
  const books = [makeBook([makeEntry({ id: 'e1', constant: true, delay: 5 })])];

  it('可见历史条数少于 delay 时压制', () => {
    const result = runScan({ books, history: turn(4) });
    expect(activatedIds(result)).toEqual([]);
    expect(rejectionOf(result, 'e1')).toEqual(['delay']);
  });

  it('达到 delay 后放行', () => {
    expect(activatedIds(runScan({ books, history: turn(5) }))).toEqual(['e1']);
  });

  it('delay 不写入状态（每轮按消息计数现算）', () => {
    expect(runScan({ books, history: turn(5) }).newState).toEqual({
      sticky: {},
      cooldown: {},
      messageCount: 5,
    });
  });
});
