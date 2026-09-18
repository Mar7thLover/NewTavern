import { describe, expect, it } from 'vitest';

import { enrichRichText, meterRatio } from './blocks.js';

const labels = {
  think: '思考',
  status: '状态',
  ooc: '场外',
  options: '选项',
  summary: '摘要',
  aside: '旁白',
  data: '变量',
};

function enrich(text: string): string {
  return enrichRichText(text, { labels });
}

describe('meterRatio', () => {
  it('分数', () => {
    expect(meterRatio('60/100')).toBeCloseTo(0.6);
    expect(meterRatio('好感度 3 / 4 点')).toBeCloseTo(0.75);
  });

  it('百分比（半角与全角）', () => {
    expect(meterRatio('42%')).toBeCloseTo(0.42);
    expect(meterRatio('42％')).toBeCloseTo(0.42);
  });

  it('符号条', () => {
    expect(meterRatio('★★★☆☆')).toBeCloseTo(0.6);
    expect(meterRatio('▰▰▱▱')).toBeCloseTo(0.5);
  });

  it('超出范围截到 0–1', () => {
    expect(meterRatio('150/100')).toBe(1);
    expect(meterRatio('-20%')).toBe(0);
  });

  it('读不出返回 null', () => {
    expect(meterRatio('黄昏')).toBeNull();
    expect(meterRatio('')).toBeNull();
  });
});

describe('标签识别', () => {
  it('英文标签用 i18n 标题', () => {
    const out = enrich('<thinking>她在犹豫。</thinking>');
    expect(out).toContain('data-nt-block="think"');
    expect(out).toContain('>思考</div>');
    expect(out).toContain('她在犹豫。');
  });

  it('中文标签用标签自己的名字当标题', () => {
    expect(enrich('<状态栏>\n好感度：60/100\n</状态栏>')).toContain('>状态栏</div>');
  });

  it('大小写不敏感，属性不影响', () => {
    expect(enrich('<THINKING class="x">嗯</THINKING>')).toContain('data-nt-block="think"');
  });

  it('自闭合标签不当容器', () => {
    expect(enrich('前<status />后')).toBe('前<status />后');
  });

  it('流式里还没收到闭合标签也能出块', () => {
    const out = enrich('<thinking>她还在想');
    expect(out).toContain('data-nt-block="think"');
    expect(out).toContain('她还在想');
  });

  it('未收录的标签原样保留', () => {
    expect(enrich('<panel>x</panel>')).toBe('<panel>x</panel>');
  });
});

describe('状态栏', () => {
  it('键值行拆成 row，数值行带 --nt-meter', () => {
    const out = enrich('<status>\n时间：黄昏\n好感度：60/100\n</status>');
    expect(out).toContain('<span data-nt-part="key">时间</span>');
    expect(out).toContain('<span data-nt-part="value-text">黄昏</span>');
    expect(out).toContain('data-nt-meter="" style="--nt-meter:0.6000"');
    expect(out).toContain('<span data-nt-part="meter" aria-hidden="true">');
  });

  it('一行里并排多组', () => {
    const out = enrich('<status>\n时间：黄昏 | 地点：酒馆\n</status>');
    expect(out).toContain('>时间</span>');
    expect(out).toContain('>地点</span>');
  });

  it('Markdown 表格行：首格是键', () => {
    const out = enrich('<status>\n| 体力 | 8/10 |\n|---|---|\n</status>');
    expect(out).toContain('>体力</span>');
    expect(out).toContain('--nt-meter:0.8000');
    expect(out).not.toContain('---');
  });

  it('没有冒号的行是 plain row', () => {
    expect(enrich('<status>\n下着雨\n</status>')).toContain('data-nt-plain=""');
  });

  it('【状态】小标题吃到空行为止', () => {
    const out = enrich('【状态】\n好感度：60/100\n\n她转过身。');
    expect(out).toContain('data-nt-block="status"');
    // 叙述落在块外面：它排在最后一个闭合标签之后
    expect(out.indexOf('她转过身。')).toBeGreaterThan(out.lastIndexOf('</div>'));
  });
});

describe('选项', () => {
  it('序号被拆成 marker', () => {
    const out = enrich('<options>\n1. 留下\n2. 离开\n</options>');
    expect(out).toContain('<ol data-nt-part="body">');
    expect(out).toContain('data-nt-marker="1"');
    expect(out).toContain('>留下</span>');
    expect(out).toContain('data-nt-marker="2"');
  });

  it('无序号时按出现顺序补', () => {
    expect(enrich('【选项】\n推门进去\n转身就走')).toContain('data-nt-marker="2"');
  });
});

describe('场外话', () => {
  it('括号形式包成行内 span', () => {
    const out = enrich('她笑了。（OOC：这里可以换个方向）');
    expect(out).toContain('<span data-nt-block="ooc" data-nt-inline="">这里可以换个方向</span>');
    expect(out).toContain('她笑了。');
  });

  it('标签形式是块', () => {
    const out = enrich('<ooc>换个方向</ooc>');
    expect(out).toContain('data-nt-block="ooc"');
    expect(out).not.toContain('data-nt-inline');
  });
});

describe('变量更新', () => {
  it('折叠成 details，内容转义', () => {
    const out = enrich('<UpdateVariable>\n_.set("a", 1 < 2);\n</UpdateVariable>');
    expect(out).toContain('<details data-nt-block="data">');
    expect(out).toContain('1 &lt; 2');
  });
});

describe('不该动的地方', () => {
  it('围栏代码里的标签不识别', () => {
    const text = '```\n<status>x</status>\n```';
    expect(enrich(text)).toBe(text);
  });

  it('行内代码里的括号不识别', () => {
    const text = '看 `（OOC：x）` 这个写法';
    expect(enrich(text)).toBe(text);
  });

  it('卡自带的 style 段不被穿透', () => {
    const text = '<style>.a::after{content:"<status>"}</style>';
    expect(enrich(text)).toBe(text);
  });

  it('普通叙述原样返回', () => {
    const text = '她推开门，雨声一下子大了起来。';
    expect(enrich(text)).toBe(text);
  });

  it('空串原样返回', () => {
    expect(enrich('')).toBe('');
  });
});

describe('开关与嵌套', () => {
  it('disabled 的类型不识别', () => {
    const text = '<thinking>x</thinking>';
    expect(enrichRichText(text, { labels, disabled: ['think'] })).toBe(text);
  });

  it('重叠的候选只取最外层', () => {
    const out = enrich('<status>\n备注：（OOC：内层）\n</status>');
    expect(out).toContain('data-nt-block="status"');
    expect(out).not.toContain('data-nt-inline');
  });

  it('escapeSource：识别之外的原文被转义，自己生成的标记还是活的', () => {
    const out = enrichRichText('<b>粗</b>\n\n<status>\n体力：<i>8</i>/10\n</status>', {
      labels,
      escapeSource: true,
    });
    expect(out).toContain('&lt;b&gt;粗&lt;/b&gt;');
    expect(out).toContain('data-nt-block="status"');
    expect(out).toContain('&lt;i&gt;8&lt;/i&gt;/10');
  });

  it('escapeSource：没认出任何块时整段转义', () => {
    expect(enrichRichText('<b>粗</b>', { labels, escapeSource: true })).toBe(
      '&lt;b&gt;粗&lt;/b&gt;',
    );
  });

  it('多个块按顺序拼回去，中间的叙述保留', () => {
    const out = enrich('<thinking>A</thinking>\n中间\n<status>\nx：1/2\n</status>');
    expect(out.indexOf('data-nt-block="think"')).toBeLessThan(out.indexOf('中间'));
    expect(out.indexOf('中间')).toBeLessThan(out.indexOf('data-nt-block="status"'));
  });
});
