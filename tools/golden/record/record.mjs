#!/usr/bin/env node
/**
 * 黄金测试录制工具：用合成 fixture 驱动本机 SillyTavern 1.18，抓取它真正发给端点的请求体。
 *
 *   node tools/golden/record/record.mjs --all
 *   node tools/golden/record/record.mjs --case preset-default-minimal
 *
 * 流程（见 docs/M3-CONTRACT.md §8.2）：
 *   ① 起一个记录请求体的 mock OpenAI 端点；
 *   ② 在 ST 目录内、用临时 dataRoot 与独立端口启动 `node server.js`（绝不碰 ST 自己的 data/）；
 *   ③ 把用例 inputs 写进该 dataRoot（卡 PNG、预设、世界书、聊天、settings.json、secrets.json）；
 *   ④ 用 headless Chrome + CDP 调 `SillyTavern.getContext()` 选角色、开聊天、发消息触发 Generate；
 *   ⑤ 把 mock 收到的原始 body 写进 tools/fixtures/st-requests/<case-id>.json。
 *
 * 只用 node: 内置模块 + 全局 fetch/WebSocket + workspace 包 @newtavern/compat（生成卡 PNG）。
 */

// 仓库根的 eslint.config.mjs 没给纯 JS 文件配 Node/浏览器 globals（TS 文件由 typescript-eslint
// 关掉了 no-undef），这里显式声明本文件用到的运行时全局量。
/* global console, fetch, setTimeout, URL, WebSocket */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

/* ───────────────────────── 让 Node 能直接加载 workspace 里的 TS 源码 ───────────────────────── */
// packages/* 用 `./x.js` 指向 `./x.ts`（打包器语义）；Node 的类型剥离不做这层重写，这里补上。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
const compat = await import('@newtavern/compat');

/* ───────────────────────── 路径与参数 ───────────────────────── */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const FIXTURES = path.join(REPO, 'tools', 'fixtures');
const CASES_FILE = path.join(FIXTURES, 'st-requests', 'cases.json');

function parseArgs(argv) {
  const out = {
    all: false,
    cases: [],
    stDir: process.env.NT_ST_DIR ?? 'D:\\Projects\\SillyTavern',
    stPort: 8100,
    mockPort: 9911,
    cdpPort: 9222,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--all':
        out.all = true;
        break;
      case '--case':
        out.cases.push(next());
        break;
      case '--st-dir':
        out.stDir = next();
        break;
      case '--st-port':
        out.stPort = Number(next());
        break;
      case '--mock-port':
        out.mockPort = Number(next());
        break;
      case '--cdp-port':
        out.cdpPort = Number(next());
        break;
      case '--keep':
        out.keep = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return out;
}

const HELP = `用法：node tools/golden/record/record.mjs [--all | --case <id> ...] [选项]

  --all                录制 cases.json 里的全部用例
  --case <id>          只录制指定用例（可重复）
  --st-dir <path>      SillyTavern 目录，默认 $NT_ST_DIR 或 D:\\Projects\\SillyTavern
  --st-port <n>        ST 监听端口，默认 8100
  --mock-port <n>      mock 端点端口，默认 9911
  --cdp-port <n>       headless Chrome 的调试端口，默认 9222
  --keep               保留临时 dataRoot 便于调试
`;

/* ───────────────────────── 小工具 ───────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const log = (...args) => console.log('[record]', ...args);

async function waitFor(label, check, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = await check();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}（${timeoutMs}ms）`);
    await sleep(intervalMs);
  }
}

/** 只按 PID 结束自己启动的进程树，绝不按镜像名批量杀 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    child.kill('SIGKILL');
  }
}

function rmDir(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // Windows 上偶尔被句柄占用，稍后重试
    }
  }
}

/* ───────────────────────── ① mock OpenAI 端点 ───────────────────────── */

const MOCK_REPLY = '记录完成。Recorded.';

function startMock(port, model) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: model, object: 'model', owned_by: 'newtavern' }],
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'bad json' } }));
          return;
        }
        requests.push({ at: new Date().toISOString(), body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `chatcmpl-golden-${requests.length}`,
            object: 'chat.completion',
            model: body.model ?? model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: MOCK_REPLY },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 },
          }),
        );
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no route ${req.method} ${url.pathname}` } }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, requests }));
  });
}

/* ───────────────────────── CDP 会话 ───────────────────────── */

class CdpSession {
  #ws;
  #id = 0;
  #pending = new Map();

  static async attach(port) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    let target = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!target) {
      target = await (
        await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
      ).json();
    }
    const session = new CdpSession();
    await session.#connect(target.webSocketDebuggerUrl);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    return session;
  }

  #connect(url) {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(url);
      this.#ws.onopen = () => resolve();
      this.#ws.onerror = (event) =>
        reject(new Error(`CDP 连接失败：${event?.message ?? 'unknown'}`));
      this.#ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const resolver = this.#pending.get(message.id);
        if (resolver) {
          this.#pending.delete(message.id);
          resolver(message);
        }
      };
    });
  }

  send(method, params) {
    return new Promise((resolve) => {
      const id = ++this.#id;
      this.#pending.set(id, resolve);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
  }

  /** 在页面里求值一段返回 JSON 字符串的异步表达式 */
  async evaluate(expression, { timeoutMs = 180000 } = {}) {
    const result = await Promise.race([
      this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs).then(() => ({ timedOut: true })),
    ]);
    if (result.timedOut) throw new Error('页面脚本执行超时');
    const payload = result.result;
    if (payload?.exceptionDetails) {
      const text =
        payload.exceptionDetails.exception?.description ??
        payload.exceptionDetails.text ??
        '未知异常';
      throw new Error(`页面脚本异常：${String(text).split('\n')[0]}`);
    }
    const value = payload?.result?.value;
    if (typeof value !== 'string') throw new Error('页面脚本没有返回字符串结果');
    return JSON.parse(value);
  }

  close() {
    try {
      this.#ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/* ───────────────────────── ③ 把用例写进 dataRoot ───────────────────────── */

const ST_WI_DEFAULTS = {
  world_info: { globalSelect: [] },
  world_info_depth: 2,
  world_info_min_activations: 0,
  world_info_min_activations_depth_max: 0,
  world_info_budget: 25,
  world_info_include_names: true,
  world_info_recursive: true,
  world_info_overflow_alert: false,
  world_info_case_sensitive: false,
  world_info_match_whole_words: true,
  world_info_character_strategy: 1,
  world_info_budget_cap: 0,
  world_info_use_group_scoring: false,
  world_info_max_recursion_steps: 0,
};

/** 预设文件里的键 → settings.json 的 oai_settings 键（其余同名） */
const PRESET_TO_OAI = {
  temperature: 'temp_openai',
  frequency_penalty: 'freq_pen_openai',
  presence_penalty: 'pres_pen_openai',
  top_p: 'top_p_openai',
  top_k: 'top_k_openai',
};

const MOCK_MODEL = 'newtavern-golden-mock';
const CHAT_FILE = 'golden';

function loadFixture(kind, id, ext = '.json') {
  const file = path.join(FIXTURES, kind, `${id}${ext}`);
  if (!fs.existsSync(file)) throw new Error(`缺少 fixture 文件：${path.relative(REPO, file)}`);
  return ext === '.json' ? readJson(file) : fs.readFileSync(file, 'utf8');
}

function writeWorldbook(userDir, id) {
  const bookData = loadFixture('worldbooks', id);
  const name = bookData.name ?? id;
  const { name: _ignored, ...rest } = bookData;
  void _ignored;
  writeJson(path.join(userDir, 'worlds', `${name}.json`), rest);
  return name;
}

/** 把一个用例的全部输入落盘；返回驱动浏览器需要的信息 */
function materializeCase(userDir, testCase, mockPort) {
  const inputs = testCase.inputs;
  const card = loadFixture('cards', inputs.card);
  const avatarFile = `${inputs.card}.png`;

  // 清掉 ST 自带的默认内容（Seraphina / Eldoria），只留本用例的素材
  for (const dir of ['characters', 'worlds', 'chats', 'OpenAI Settings']) {
    rmDir(path.join(userDir, dir));
    fs.mkdirSync(path.join(userDir, dir), { recursive: true });
  }

  // 角色卡 PNG（现场生成，不提交二进制）
  fs.mkdirSync(path.join(userDir, 'characters'), { recursive: true });
  fs.writeFileSync(path.join(userDir, 'characters', avatarFile), compat.writeCardToPng(null, card));

  // 世界书
  const globalBooks = (inputs.worldbooks ?? []).map((id) => writeWorldbook(userDir, id));
  if (inputs.characterBook) writeWorldbook(userDir, inputs.characterBook);
  const chatBook = inputs.chatLorebook ? writeWorldbook(userDir, inputs.chatLorebook) : null;

  // 预设：强制指向 mock 端点
  const preset = {
    ...loadFixture('presets', inputs.preset),
    chat_completion_source: 'custom',
    custom_url: `http://127.0.0.1:${mockPort}/v1`,
    custom_model: MOCK_MODEL,
    stream_openai: false,
  };
  const presetName = inputs.preset;
  writeJson(path.join(userDir, 'OpenAI Settings', `${presetName}.json`), preset);

  // 聊天记录：把作者注释与聊天世界书写进首行 chat_metadata
  const chatText = loadFixture('chats', inputs.chat, '.jsonl');
  const lines = chatText.split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = JSON.parse(lines[0]);
  const persona = loadFixture('personas', inputs.persona);
  header.user_name = persona.name;
  header.character_name = card.data.name;
  const metadata = { ...(header.chat_metadata ?? {}) };
  const note = inputs.authorsNote;
  metadata.note_prompt = note?.text ?? '';
  metadata.note_interval = note?.interval ?? 1;
  metadata.note_position = note?.position ?? 1;
  metadata.note_depth = note?.depth ?? 4;
  metadata.note_role = note?.role ?? 0;
  if (chatBook) metadata.world_info = chatBook;
  header.chat_metadata = metadata;
  const body = lines.slice(1).map((line) => {
    const message = JSON.parse(line);
    if (message.is_user) message.name = persona.name;
    else if (message.name !== 'System') message.name = card.data.name;
    return JSON.stringify(message);
  });
  const chatDir = path.join(userDir, 'chats', inputs.card);
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(
    path.join(chatDir, `${CHAT_FILE}.jsonl`),
    `${[JSON.stringify(header), ...body].join('\n')}\n`,
  );

  // 正则脚本（全局）
  const regexScripts = (inputs.globalRegex ?? []).flatMap((id) => loadFixture('regex', id));

  // settings.json
  const settingsFile = path.join(userDir, 'settings.json');
  const settings = readJson(settingsFile);
  settings.firstRun = false;
  settings.main_api = 'openai';
  settings.username = persona.name;
  settings.user_avatar = 'user-default.png';
  settings.active_character = '';
  settings.active_group = '';
  settings.world_info_settings = {
    ...ST_WI_DEFAULTS,
    ...(inputs.settings ?? {}),
    world_info: { globalSelect: globalBooks },
  };
  const oai = { ...settings.oai_settings, ...preset, preset_settings_openai: presetName };
  delete oai.prompts;
  delete oai.prompt_order;
  oai.prompts = preset.prompts;
  oai.prompt_order = preset.prompt_order;
  for (const [presetKey, oaiKey] of Object.entries(PRESET_TO_OAI)) {
    if (preset[presetKey] !== undefined) oai[oaiKey] = preset[presetKey];
  }
  settings.oai_settings = oai;
  settings.preset_settings = settings.preset_settings ?? 'Default';
  settings.power_user = {
    ...settings.power_user,
    personas: { 'user-default.png': persona.name },
    persona_descriptions: {
      'user-default.png': {
        description: persona.description,
        position: 0,
        depth: 2,
        role: 0,
        lorebook: '',
        title: '',
      },
    },
    default_persona: 'user-default.png',
    persona_description: persona.description,
    persona_description_position: 0,
    persona_description_depth: 2,
    persona_description_role: 0,
    world_import_dialog: false,
  };
  settings.extension_settings = {
    ...settings.extension_settings,
    regex: regexScripts,
    character_allowed_regex: [avatarFile],
  };
  writeJson(settingsFile, settings);

  writeJson(path.join(userDir, 'secrets.json'), { api_key_custom: 'newtavern-golden-fake-key' });

  return { avatarFile, presetName };
}

/* ───────────────────────── ④ 浏览器侧驱动脚本 ───────────────────────── */

function buildDriverScript({ avatarFile, presetName, priorUserMessages, userMessage }) {
  const payload = JSON.stringify({ avatarFile, presetName, priorUserMessages, userMessage });
  return `(async () => {
  const input = ${payload};
  const notes = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await fn()) return true; } catch (e) { /* 页面还没就绪 */ }
      await sleep(250);
    }
    return false;
  };
  if (!(await waitFor(() => globalThis.SillyTavern?.getContext, 120000))) {
    return JSON.stringify({ ok: false, error: 'SillyTavern.getContext 未就绪' });
  }
  const ctx = () => globalThis.SillyTavern.getContext();
  if (!(await waitFor(() => ctx().characters?.length > 0, 60000))) {
    return JSON.stringify({ ok: false, error: '角色列表为空' });
  }
  document.querySelector('#api_button_openai')?.click();
  if (!(await waitFor(() => ctx().onlineStatus && ctx().onlineStatus !== 'no_connection', 30000))) {
    notes.push('连接状态未变为已连接（custom 源允许直接生成，继续）');
  }
  try {
    await ctx().executeSlashCommandsWithOptions('/preset ' + input.presetName, { handleParserErrors: true });
    await sleep(800);
  } catch (e) {
    notes.push('/preset 失败：' + String(e && e.message ? e.message : e));
  }
  const index = ctx().characters.findIndex((c) => c.avatar === input.avatarFile);
  if (index < 0) return JSON.stringify({ ok: false, error: '找不到角色卡 ' + input.avatarFile });
  // this_chid 可能是字符串，统一成数字比较
  const currentId = () => (ctx().characterId === undefined ? -1 : Number(ctx().characterId));
  if (currentId() !== index) {
    await ctx().selectCharacterById(index);
    await sleep(1200);
  }
  if (currentId() !== index) {
    return JSON.stringify({ ok: false, error: '选择角色失败，characterId=' + ctx().characterId });
  }
  await ctx().openCharacterChat('golden');
  if (!(await waitFor(() => ctx().getCurrentChatId() === 'golden', 30000))) {
    return JSON.stringify({ ok: false, error: '打开聊天文件 golden.jsonl 失败' });
  }
  await sleep(600);
  const send = async (text) => {
    const area = document.querySelector('#send_textarea');
    if (!area) throw new Error('找不到输入框 #send_textarea');
    area.value = text;
    await ctx().generate('normal');
    await sleep(400);
  };
  for (const prior of input.priorUserMessages) {
    await send(prior);
  }
  const before = ctx().chat.length;
  await send(input.userMessage);
  const after = ctx().chat.length;
  if (after <= before) notes.push('Generate 后聊天长度未增加（before=' + before + ' after=' + after + '）');
  return JSON.stringify({
    ok: true,
    notes,
    chatLength: after,
    noteText: ctx().chatMetadata?.note_prompt ?? '',
  });
})()`;
}

/* ───────────────────────── 主流程 ───────────────────────── */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const casesDoc = readJson(CASES_FILE);
  const all = casesDoc.cases;
  const selected = args.all
    ? all
    : args.cases.map((id) => {
        const found = all.find((c) => c.id === id);
        if (!found) throw new Error(`cases.json 里没有用例：${id}`);
        return found;
      });
  if (selected.length === 0) {
    console.log(HELP);
    throw new Error('请用 --all 或 --case <id> 指定要录制的用例');
  }

  const serverJs = path.join(args.stDir, 'server.js');
  if (!fs.existsSync(serverJs))
    throw new Error(`找不到 ST：${serverJs}（用 --st-dir 或 NT_ST_DIR 指定）`);

  const runRoot = path.join(os.tmpdir(), 'newtavern-golden', String(Date.now()));
  const dataRoot = path.join(runRoot, 'data');
  const templateDir = path.join(runRoot, 'template');
  const chromeProfile = path.join(runRoot, 'chrome');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(chromeProfile, { recursive: true });
  log('临时 dataRoot：', dataRoot);

  let mock;
  let stProcess;
  let chromeProcess;
  let cdp;
  const cleanup = () => {
    cdp?.close();
    killTree(chromeProcess);
    killTree(stProcess);
    mock?.server.close();
    if (!args.keep) {
      setTimeout(() => rmDir(runRoot), 1500);
    } else {
      log('--keep：保留', runRoot);
    }
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  const results = [];
  try {
    /* ① mock */
    mock = await startMock(args.mockPort, MOCK_MODEL);
    log(`mock 端点 http://127.0.0.1:${args.mockPort}/v1`);

    /* ② ST */
    const stLog = fs.createWriteStream(path.join(runRoot, 'sillytavern.log'));
    stProcess = spawn(
      process.execPath,
      [
        'server.js',
        '--dataRoot',
        dataRoot,
        '--port',
        String(args.stPort),
        '--listen',
        'false',
        '--browserLaunchEnabled',
        'false',
        '--whitelist',
        'false',
        '--basicAuthMode',
        'false',
        '--disableCsrf',
        'true',
      ],
      { cwd: args.stDir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    stProcess.stdout.pipe(stLog);
    stProcess.stderr.pipe(stLog);
    stProcess.on('exit', (code) => log(`ST 进程退出，code=${code}`));
    await waitFor(
      'SillyTavern 启动',
      async () => (await fetch(`http://127.0.0.1:${args.stPort}/`)).ok,
      240000,
      1000,
    );
    log(`SillyTavern 已就绪 http://127.0.0.1:${args.stPort}/`);

    /* 干净 default-user 的模板快照（含 ST 自己铺的默认内容） */
    const userDir = path.join(dataRoot, 'default-user');
    await waitFor(
      'default-user 初始化',
      () => fs.existsSync(path.join(userDir, 'settings.json')),
      60000,
    );
    await sleep(1500);
    fs.cpSync(userDir, templateDir, { recursive: true });

    /* ③ Chrome */
    const chromeBin =
      process.env.NT_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    chromeProcess = spawn(
      chromeBin,
      [
        '--headless=new',
        `--remote-debugging-port=${args.cdpPort}`,
        `--user-data-dir=${chromeProfile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    await waitFor(
      'headless Chrome 启动',
      async () => (await fetch(`http://127.0.0.1:${args.cdpPort}/json/version`)).ok,
      60000,
      500,
    );
    cdp = await CdpSession.attach(args.cdpPort);
    log('headless Chrome 已连接');

    /* ⑤ 逐个用例 */
    for (const [index, testCase] of selected.entries()) {
      const label = `${index + 1}/${selected.length} ${testCase.id}`;
      let record;
      try {
        await cdp.navigate('about:blank');
        await sleep(600);
        rmDir(userDir);
        fs.cpSync(templateDir, userDir, { recursive: true });
        const { avatarFile, presetName } = materializeCase(userDir, testCase, args.mockPort);

        const mark = mock.requests.length;
        await cdp.navigate(`http://127.0.0.1:${args.stPort}/`);
        const driven = await cdp.evaluate(
          buildDriverScript({
            avatarFile,
            presetName,
            priorUserMessages: testCase.inputs.priorUserMessages ?? [],
            userMessage: testCase.inputs.userMessage,
          }),
        );
        if (!driven.ok) throw new Error(driven.error);
        await waitFor('mock 收到请求', () => mock.requests.length > mark, 30000, 200);
        const captured = mock.requests[mock.requests.length - 1];
        const notes = [...(driven.notes ?? [])];
        const expectedRequests = 1 + (testCase.inputs.priorUserMessages ?? []).length;
        if (mock.requests.length - mark !== expectedRequests) {
          notes.push(
            `mock 收到 ${mock.requests.length - mark} 个请求，预期 ${expectedRequests} 个（取最后一个）`,
          );
        }
        record = {
          id: testCase.id,
          description: testCase.description,
          stVersion: '1.18.0',
          capturedAt: captured.at,
          inputs: testCase.inputs,
          expect: testCase.expect,
          request: captured.body,
          notes,
        };
        writeJson(path.join(FIXTURES, 'st-requests', `${testCase.id}.json`), record);
        results.push({ id: testCase.id, ok: true, notes });
        log(`✓ ${label}（messages=${captured.body?.messages?.length ?? '?'}）`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        results.push({ id: testCase.id, ok: false, reason });
        log(`✗ ${label}：${reason}`);
      }
    }

    /* 回写录制状态 */
    const byId = new Map(results.map((r) => [r.id, r]));
    for (const testCase of all) {
      const result = byId.get(testCase.id);
      if (!result) continue;
      testCase.recorded = result.ok;
      if (result.ok) {
        delete testCase.notRecordedReason;
      } else {
        testCase.notRecordedReason = result.reason;
      }
    }
    writeJson(CASES_FILE, casesDoc);

    const ok = results.filter((r) => r.ok).length;
    log(`完成：成功 ${ok} / ${results.length}`);
    if (ok < results.length) {
      for (const failure of results.filter((r) => !r.ok)) {
        log(`  失败 ${failure.id}：${failure.reason}`);
      }
    }
  } finally {
    cleanup();
  }
}

await main();
