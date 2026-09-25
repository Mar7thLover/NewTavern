import { randomUUID } from 'node:crypto';

import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * 领域模型表。见 docs/PLAN.md §3.3。
 * 灵活字段用 JSON 列，可查询字段拉平。DB 是唯一真源，文件系统只存二进制与原始导入件。
 * M4（二）/ M5（三）/ M6 / M7 的表（scripts、character_sprites、writing_projects、documents、
 * document_versions）在迁移 0003 一次加齐；game_states 等 M8 表届时再加。
 */

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID());

const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date());

const updatedAt = () =>
  integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date());

/**
 * 创作工作台标记（迁移 0004）：null = 库里的原件；非 null = 工作台自己的
 * （`sourceId` 是复制来源，工作台里新建的为 null）。从工作台打开原件时先复制一份，
 * 编辑的是副本，原件不动（见 services/studio-fork.ts）。
 */
export type StudioMarker = { sourceId: string | null };

const studio = () => text('studio', { mode: 'json' }).$type<StudioMarker>();

/** KV 设置：连接档案之外的全局配置、全局系统提示词覆盖层等 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: updatedAt(),
});

/** 内容寻址的二进制资产：头像、背景、立绘、生图结果、卡内资源 */
export const assets = sqliteTable(
  'assets',
  {
    id: id(),
    kind: text('kind', {
      enum: ['avatar', 'background', 'emotion', 'generated', 'upload', 'card_embedded'],
    }).notNull(),
    mime: text('mime').notNull(),
    /** 相对数据目录的路径（assets/<sha256 前两位>/<sha256>） */
    path: text('path').notNull(),
    sha256: text('sha256').notNull(),
    width: integer('width'),
    height: integer('height'),
    /** 来源说明：import / upload / generated:<jobId> / card:<characterId> */
    source: text('source'),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('assets_sha256_idx').on(t.sha256)],
);

/** 角色卡：data 为完整 CCv3 data JSON，未知字段原样保留 */
export const characters = sqliteTable(
  'characters',
  {
    id: id(),
    name: text('name').notNull(),
    spec: text('spec', { enum: ['v2', 'v3'] }).notNull(),
    data: text('data', { mode: 'json' }).notNull(),
    /** 内嵌世界书抽到 lorebooks 后的关联（scope='char'） */
    bookId: text('book_id'),
    avatarAssetId: text('avatar_asset_id'),
    /** 原始导入件相对路径（未修改则导出原件） */
    sourcePath: text('source_path'),
    originalHash: text('original_hash'),
    /**
     * 在新酒馆里编辑过卡字段的时间（工作台 PUT 写入）。非空时导出不再回原件字节，
     * 而是从 data 重新写（M6 契约）。
     */
    editedAt: integer('edited_at', { mode: 'timestamp_ms' }),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    studio: studio(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('characters_name_idx').on(t.name)],
);

export const presets = sqliteTable('presets', {
  id: id(),
  name: text('name').notNull(),
  format: text('format', { enum: ['st-openai', 'native'] }).notNull(),
  /** openai-chat / openai-responses / anthropic / google */
  apiFamily: text('api_family'),
  data: text('data', { mode: 'json' }).notNull(),
  sampling: text('sampling', { mode: 'json' }).$type<Record<string, unknown>>(),
  layoutPolicy: text('layout_policy', { mode: 'json' }).$type<Record<string, unknown>>(),
  studio: studio(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const lorebooks = sqliteTable('lorebooks', {
  id: id(),
  name: text('name').notNull(),
  scope: text('scope', { enum: ['global', 'char', 'chat'] })
    .notNull()
    .default('global'),
  /** scan_depth / token_budget / recursive_scanning 等书级设置 */
  settings: text('settings', { mode: 'json' }).$type<Record<string, unknown>>(),
  studio: studio(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 世界书条目：ST 字段逐列拉平，装饰器与未知字段进 JSON 兜底 */
export const lorebookEntries = sqliteTable(
  'lorebook_entries',
  {
    id: id(),
    bookId: text('book_id')
      .notNull()
      .references(() => lorebooks.id, { onDelete: 'cascade' }),
    /** ST 原生 uid（往返保留） */
    uid: integer('uid'),
    keys: text('keys', { mode: 'json' }).$type<string[]>().notNull().default([]),
    secondaryKeys: text('secondary_keys', { mode: 'json' }).$type<string[]>().notNull().default([]),
    content: text('content').notNull().default(''),
    comment: text('comment'),
    constant: integer('constant', { mode: 'boolean' }).notNull().default(false),
    selective: integer('selective', { mode: 'boolean' }).notNull().default(false),
    selectiveLogic: integer('selective_logic'),
    position: integer('position').notNull().default(0),
    depth: integer('depth'),
    entryOrder: integer('order').notNull().default(100),
    probability: integer('probability'),
    group: text('group'),
    groupOverride: integer('group_override', { mode: 'boolean' }),
    groupWeight: integer('group_weight'),
    scanDepth: integer('scan_depth'),
    caseSensitive: integer('case_sensitive', { mode: 'boolean' }),
    matchWholeWords: integer('match_whole_words', { mode: 'boolean' }),
    useGroupScoring: integer('use_group_scoring', { mode: 'boolean' }),
    automationId: text('automation_id'),
    role: text('role'),
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
    sticky: integer('sticky'),
    cooldown: integer('cooldown'),
    delay: integer('delay'),
    excludeRecursion: integer('exclude_recursion', { mode: 'boolean' }),
    preventRecursion: integer('prevent_recursion', { mode: 'boolean' }),
    delayUntilRecursion: integer('delay_until_recursion', { mode: 'boolean' }),
    ignoreBudget: integer('ignore_budget', { mode: 'boolean' }),
    /** CCv3 装饰器归一化结果（@@depth 等） */
    decorators: text('decorators', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** { stKey, raw }：原始 ST 条目与其在 entries 中的 key；导出时以 raw 为底叠加列值，保证无损 */
    extra: text('extra', { mode: 'json' }).$type<Record<string, unknown>>(),
    displayIndex: integer('display_index'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('lorebook_entries_book_idx').on(t.bookId)],
);

/**
 * 用户档案，对齐 ST `power_user.persona_descriptions[avatar]`
 * （`public/scripts/personas.js`：description / title / position / depth / role / lorebook）。
 * `position` 是列表排序；描述放在哪用 `descriptionPosition`，取值对应 ST
 * `persona_description_positions` 的 IN_PROMPT(0) / TOP_AN(2) / BOTTOM_AN(3) / AT_DEPTH(4) / NONE(9)。
 */
export const personas = sqliteTable('personas', {
  id: id(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  /** ST `title`：档案卡上名字下面的小字，不进提示词 */
  title: text('title').notNull().default(''),
  avatarAssetId: text('avatar_asset_id'),
  position: integer('position').notNull().default(0),
  descriptionPosition: text('description_position', {
    enum: ['in_prompt', 'top_an', 'bottom_an', 'at_depth', 'none'],
  })
    .notNull()
    .default('in_prompt'),
  /** ST `DEFAULT_DEPTH = 2`；只在 at_depth 时生效 */
  depth: integer('depth').notNull().default(2),
  /** ST `DEFAULT_ROLE = 0`（extension_prompt_roles.SYSTEM）；只在 at_depth 时生效 */
  role: text('role', { enum: ['system', 'user', 'assistant'] })
    .notNull()
    .default('system'),
  /** ST `lorebook`：绑定的世界书（删除世界书时置空） */
  lorebookId: text('lorebook_id').references(() => lorebooks.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const chats = sqliteTable('chats', {
  id: id(),
  title: text('title').notNull().default(''),
  mode: text('mode', { enum: ['roleplay', 'writing', 'crpg'] })
    .notNull()
    .default('roleplay'),
  characterIds: text('character_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  personaId: text('persona_id'),
  presetId: text('preset_id'),
  overrides: text('overrides', { mode: 'json' }).$type<Record<string, unknown>>(),
  /** 消息树根/当前头指针 */
  rootNodeId: text('root_node_id'),
  headNodeId: text('head_node_id'),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const chatLorebooks = sqliteTable(
  'chat_lorebooks',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    bookId: text('book_id')
      .notNull()
      .references(() => lorebooks.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('chat_lorebooks_pair_idx').on(t.chatId, t.bookId)],
);

/**
 * 消息节点：树结构。无后代的兄弟即 swipe，有后代即分支；切换 head 即切换分支。
 */
export const messageNodes = sqliteTable(
  'message_nodes',
  {
    id: id(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    siblingSeq: integer('sibling_seq').notNull().default(0),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    name: text('name'),
    parts: text('parts', { mode: 'json' }).notNull(),
    /** { text?, provider?, model?, opaque?[] } */
    reasoning: text('reasoning', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** 消息级变量快照（MVU commit 结果） */
    variables: text('variables', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** sticky/cooldown/delay 快照（按节点起算，swipe/重生从父节点恢复） */
    wiState: text('wi_state', { mode: 'json' }).$type<Record<string, unknown>>(),
    usage: text('usage', { mode: 'json' }).$type<Record<string, unknown>>(),
    provider: text('provider'),
    model: text('model'),
    isHidden: integer('is_hidden', { mode: 'boolean' }).notNull().default(false),
    extra: text('extra', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index('message_nodes_chat_idx').on(t.chatId),
    index('message_nodes_parent_idx').on(t.parentId),
  ],
);

export const variables = sqliteTable(
  'variables',
  {
    id: id(),
    scope: text('scope', {
      enum: ['global', 'character', 'chat', 'script', 'preset'],
    }).notNull(),
    ownerId: text('owner_id').notNull().default(''),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('variables_scope_owner_key_idx').on(t.scope, t.ownerId, t.key)],
);

/** 变量事务日志（MVU 审计/回放） */
export const variableEvents = sqliteTable('variable_events', {
  id: id(),
  scope: text('scope').notNull(),
  ownerId: text('owner_id').notNull().default(''),
  nodeId: text('node_id'),
  op: text('op').notNull(),
  path: text('path').notNull(),
  oldValue: text('old_value', { mode: 'json' }),
  newValue: text('new_value', { mode: 'json' }),
  createdAt: createdAt(),
});

export const connections = sqliteTable('connections', {
  id: id(),
  /**
   * 对话提供商（openai-chat / openai-responses / anthropic / google），
   * 或外接生图后端（image-sd / image-comfy / image-novelai / image-openai，M4（二））。
   */
  provider: text('provider').notNull(),
  label: text('label').notNull().default(''),
  baseUrl: text('base_url').notNull(),
  /** 主密钥加密后的多 Key 列表 */
  keysEnc: text('keys_enc').notNull().default(''),
  headers: text('headers', { mode: 'json' }).$type<Record<string, string>>(),
  proxy: text('proxy'),
  quirks: text('quirks', { mode: 'json' }).$type<Record<string, boolean>>(),
  modelOverrides: text('model_overrides', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const modelCache = sqliteTable('model_cache', {
  id: id(),
  connectionId: text('connection_id')
    .notNull()
    .references(() => connections.id, { onDelete: 'cascade' }),
  models: text('models', { mode: 'json' }).$type<unknown[]>().notNull().default([]),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }),
});

export const generationLog = sqliteTable(
  'generation_log',
  {
    id: id(),
    nodeId: text('node_id'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    usage: text('usage', { mode: 'json' }).$type<Record<string, unknown>>(),
    cost: integer('cost'),
    latencyMs: integer('latency_ms'),
    layoutMode: text('layout_mode', { enum: ['strict', 'cache-aware'] }),
    createdAt: createdAt(),
  },
  (t) => [index('generation_log_node_idx').on(t.nodeId)],
);

export const regexScripts = sqliteTable('regex_scripts', {
  id: id(),
  /**
   * 脚本从哪来（与 ST 的三类对齐，另加世界书）：
   * `global` 用户自己的；其余三种是角色卡 / 预设 / 世界书自带、导入时抽进来的，
   * `owner_id` 指向那条记录（M3 契约 §3.2 修正）。
   */
  scope: text('scope', { enum: ['global', 'character', 'preset', 'book'] })
    .notNull()
    .default('global'),
  ownerId: text('owner_id'),
  scriptName: text('script_name').notNull(),
  findRegex: text('find_regex').notNull(),
  replaceString: text('replace_string').notNull().default(''),
  placement: text('placement', { mode: 'json' }).$type<number[]>().notNull().default([]),
  direction: text('direction', { enum: ['prompt', 'display', 'both'] })
    .notNull()
    .default('both'),
  disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
  runOnEdit: integer('run_on_edit', { mode: 'boolean' }).notNull().default(false),
  minDepth: integer('min_depth'),
  maxDepth: integer('max_depth'),
  trimStrings: text('trim_strings', { mode: 'json' }).$type<string[]>(),
  substituteRegex: integer('substitute_regex'),
  extra: text('extra', { mode: 'json' }).$type<Record<string, unknown>>(),
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 预设/角色/世界书版本历史，支撑工作台 AI 编辑撤销 */
export const entityVersions = sqliteTable(
  'entity_versions',
  {
    id: id(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    version: integer('version').notNull(),
    data: text('data', { mode: 'json' }).notNull(),
    author: text('author', { enum: ['user', 'ai'] })
      .notNull()
      .default('user'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('entity_versions_idx').on(t.entityType, t.entityId, t.version)],
);

/** 可复用提示片段 */
export const promptLibrary = sqliteTable('prompt_library', {
  id: id(),
  name: text('name').notNull(),
  content: text('content').notNull().default(''),
  role: text('role'),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * 酒馆助手脚本库（M5（三））：用户自己的全局脚本与预设绑定脚本。
 * 角色卡脚本仍存在卡的 `extensions` 里（保证往返无损），不进这张表。
 * `data` 保存原件（酒馆助手导出的脚本 JSON）全部字段，导出时以它为底叠加列值。
 */
export const scripts = sqliteTable('scripts', {
  id: id(),
  scope: text('scope', { enum: ['global', 'preset'] })
    .notNull()
    .default('global'),
  /** scope='preset' 时指向 presets.id */
  ownerId: text('owner_id'),
  name: text('name').notNull(),
  content: text('content').notNull().default(''),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  /** 酒馆助手的脚本按钮：{ name, visible }[] */
  buttons: text('buttons', { mode: 'json' }).$type<Record<string, unknown>[]>().notNull().default([]),
  data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 立绘表情（M4（二））：每个角色每个表情标签一张图 */
export const characterSprites = sqliteTable(
  'character_sprites',
  {
    id: id(),
    characterId: text('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    /** ST 表情标签（neutral / joy / anger …）或用户自定义标签 */
    label: text('label').notNull(),
    assetId: text('asset_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('character_sprites_char_label_idx').on(t.characterId, t.label)],
);

/** 长篇写作项目（M7） */
export const writingProjects = sqliteTable('writing_projects', {
  id: id(),
  title: text('title').notNull().default(''),
  /** { connectionId?, model?, layoutMode?, styleGuide?, systemPrompt?, contextBudget? } */
  settings: text('settings', { mode: 'json' }).$type<Record<string, unknown>>(),
  /** 设定圣经：复用世界书 */
  lorebookIds: text('lorebook_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  outline: text('outline').notNull().default(''),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 写作项目里的章节与笔记（M7） */
export const documents = sqliteTable(
  'documents',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => writingProjects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['chapter', 'note'] })
      .notNull()
      .default('chapter'),
    title: text('title').notNull().default(''),
    docOrder: integer('doc_order').notNull().default(0),
    /** ProseMirror (TipTap) JSON */
    content: text('content', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** 纯文本（组装上下文、字数、导出用） */
    text: text('text').notNull().default(''),
    summary: text('summary').notNull().default(''),
    /** 正文在摘要生成之后又改过 */
    summaryStale: integer('summary_stale', { mode: 'boolean' }).notNull().default(false),
    /** 章节已完成（完成时自动生成摘要） */
    done: integer('done', { mode: 'boolean' }).notNull().default(false),
    wordCount: integer('word_count').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('documents_project_idx').on(t.projectId)],
);

export const documentVersions = sqliteTable(
  'document_versions',
  {
    id: id(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: text('content', { mode: 'json' }).$type<Record<string, unknown>>(),
    text: text('text').notNull().default(''),
    author: text('author', { enum: ['user', 'ai'] })
      .notNull()
      .default('user'),
    label: text('label'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('document_versions_idx').on(t.documentId, t.version)],
);

export const jobs = sqliteTable('jobs', {
  id: id(),
  kind: text('kind', { enum: ['image_gen', 'summary', 'import'] }).notNull(),
  status: text('status', { enum: ['pending', 'running', 'done', 'failed'] })
    .notNull()
    .default('pending'),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>(),
  result: text('result', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
