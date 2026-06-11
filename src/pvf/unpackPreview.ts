import * as fs from 'fs/promises';
import * as path from 'path';
import type * as vscode from 'vscode';
import {
  UnpackMetadataService,
  UnpackResolvedMetadata,
  normalizeUnpackKey,
  rarityLabel,
  readLstFileToCodeMap,
  shouldResolveUnpackMetadataKey,
} from './unpackMetadata';

export type UnpackPreviewKind =
  | 'equipment'
  | 'equipmentSet'
  | 'stackable'
  | 'shop'
  | 'quest'
  | 'skill'
  | 'skillTree'
  | 'error';

export interface UnpackPreviewIcon {
  src: string;
  width?: number;
  height?: number;
  isQuestTag?: boolean;
}

export interface UnpackPreviewField {
  label: string;
  value: string;
  tagName?: string;
  tone?: 'normal' | 'muted' | 'good' | 'magic' | 'warning' | 'danger';
}

export interface UnpackPreviewEntry {
  code?: number;
  name?: string;
  key?: string;
  quantity?: number;
  detail?: string;
  x?: number;
  y?: number;
  branch?: string;
  common?: boolean;
  unresolved?: boolean;
  icon?: UnpackPreviewIcon;
}

export interface UnpackPreviewSection {
  title: string;
  fields?: UnpackPreviewField[];
  lines?: string[];
  entries?: UnpackPreviewEntry[];
  tone?: 'normal' | 'blue' | 'flavor' | 'set' | 'shop' | 'quest' | 'skill';
}

export interface UnpackPreviewMiniMapPoint {
  x: number;
  y: number;
  resolved: boolean;
  common?: boolean;
  label?: string;
}

export interface UnpackPreviewMiniMap {
  points: UnpackPreviewMiniMapPoint[];
}

export interface UnpackHoverPreview {
  kind: UnpackPreviewKind;
  title: string;
  subtitle?: string;
  key: string;
  fsPath: string;
  itemCode?: number;
  rarity?: number;
  rarityLabel?: string;
  icon?: UnpackPreviewIcon;
  badges?: string[];
  sections: UnpackPreviewSection[];
  miniMap?: UnpackPreviewMiniMap;
  message?: string;
  text?: string;
}

export interface UnpackPreviewInput {
  fsPath: string;
  key: string;
  name: string;
  root: string;
  version: string;
  isDirectory?: boolean;
}

export interface UnpackPreviewOptions {
  resolveIcon?: boolean;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  iconSettled: boolean;
  preview: UnpackHoverPreview | undefined;
}

interface LstCacheEntry {
  mtimeMs: number;
  size: number;
  fileToCode: Map<string, number>;
  codeToFile: Map<number, string>;
}

interface ParsedTags {
  values: Map<string, string[]>;
}

interface ScriptTagTitleFile {
  tags?: Array<{ name?: unknown; title?: unknown }>;
}

interface PreviewTagTitle {
  name: string;
  title: string;
}

type PreviewTagTitles = ReadonlyMap<string, PreviewTagTitle>;

interface CodeReference {
  code: number;
  key?: string;
  fsPath?: string;
  name?: string;
  metadata?: UnpackResolvedMetadata;
  unresolved?: boolean;
}

interface SkillTreeNode {
  code: number;
  x?: number;
  y?: number;
  branch?: string;
  common?: boolean;
  nextSkills: number[];
}

const EQUIPMENT_LST = ['equipment/equipment.lst'];
const STACKABLE_LST = ['stackable/stackable.lst'];
const ITEM_LSTS = [...EQUIPMENT_LST, ...STACKABLE_LST];
const SKILL_LISTS_BY_JOB: Record<string, string[]> = {
  swordman: ['skill/swordmanskill.lst'],
  'at swordman': ['skill/atswordmanskill.lst'],
  atswordman: ['skill/atswordmanskill.lst'],
  fighter: ['skill/fighterskill.lst'],
  'at fighter': ['skill/atfighterskill.lst'],
  atfighter: ['skill/atfighterskill.lst'],
  gunner: ['skill/gunnerskill.lst'],
  'at gunner': ['skill/atgunnerskill.lst'],
  atgunner: ['skill/atgunnerskill.lst'],
  mage: ['skill/mageskill.lst'],
  'at mage': ['skill/atmageskill.lst'],
  atmage: ['skill/atmageskill.lst'],
  priest: ['skill/priestskill.lst'],
  thief: ['skill/thiefskill.lst'],
  'demonic swordman': ['skill/demonicswordman.lst'],
  demonicswordman: ['skill/demonicswordman.lst'],
  creator: ['skill/creatormageskill.lst', 'skill/creatormage.lst'],
  'creator mage': ['skill/creatormageskill.lst', 'skill/creatormage.lst'],
  creatormage: ['skill/creatormageskill.lst', 'skill/creatormage.lst'],
  common: ['skill/skilllist.lst', 'skill/skill.lst'],
};
const COMMON_SKILL_LSTS = ['skill/skilllist.lst', 'skill/skill.lst'];

const BLOCK_VALUE_TAGS = new Set([
  'a condition item',
  'b condition item',
  'booster random',
  'command',
  'common skill',
  'consume item',
  'dungeon info',
  'enemy reward item',
  'etc',
  'executable states',
  'int data',
  'level info',
  'level property',
  'material',
  'monster reward item',
  'need material',
  'output',
  'package data',
  'piece set ability',
  'pre required skill',
  'purchase cost',
  'random list',
  'result item',
  'reward int data',
  'reward selection int data',
  'sell item',
  'set ability',
  'set item',
  'skill fitness growtype',
  'skill fitness second growtype',
  'skill info',
  'skill levelup',
  'skill under cooltime effect',
  'skill under cooltime effect each',
  'special level up',
  'special purchase cost',
  'spending item',
  'static data',
  'string data',
  'usable job',
]);

const EQUIPMENT_STAT_LABELS: Record<string, string> = {
  'equipment physical attack': '物理攻击力',
  'equipment magical attack': '魔法攻击力',
  'equipment physical defense': '物理防御力',
  'equipment magical defense': '魔法防御力',
  'separate attack': '独立攻击力',
  'physical attack': '力量',
  'magical attack': '智力',
  'physical defense': '体力',
  'magical defense': '精神',
};

const EQUIPMENT_MAGIC_LABELS: Record<string, string> = {
  'physical critical hit': '物理暴击率',
  'magical critical hit': '魔法暴击率',
  'attack speed': '攻击速度',
  'cast speed': '施放速度',
  'move speed': '移动速度',
  'jump power': '跳跃力',
  'hit recovery': '硬直',
  'room list move speed rate': '城镇移动速度',
  stuck: '命中率',
  'stuck resistance': '回避率',
  'hp max': 'HP 最大值',
  'mp max': 'MP 最大值',
  'hp regen speed': 'HP 回复速度',
  'mp regen speed': 'MP 回复速度',
  'all elemental resistance': '所有属性抗性',
  'all elemental attack': '所有属性强化',
  'fire attack': '火属性强化',
  'water attack': '冰属性强化',
  'ice attack': '冰属性强化',
  'light attack': '光属性强化',
  'dark attack': '暗属性强化',
  'inventory limit': '负重上限',
  'slow resistance': '减速抗性',
  'freeze resistance': '冰冻抗性',
  'poison resistance': '中毒抗性',
  'stun resistance': '眩晕抗性',
  'curse resistance': '诅咒抗性',
  'blind resistance': '失明抗性',
  'lightning resistance': '感电抗性',
  'stone resistance': '石化抗性',
  'sleep resistance': '睡眠抗性',
  'bleeding resistance': '出血抗性',
  'confuse resistance': '混乱抗性',
  'hold resistance': '束缚抗性',
  'burn resistance': '灼伤抗性',
  'weapon break resistance': '武器破坏抗性',
  'armor break resistance': '防具破坏抗性',
  'piercing resistance': '贯通抗性',
};

const JOB_LABELS: Record<string, string> = {
  all: '所有职业',
  swordman: '鬼剑士(男)',
  'at swordman': '鬼剑士(女)',
  atswordman: '鬼剑士(女)',
  fighter: '格斗家(女)',
  'at fighter': '格斗家(男)',
  atfighter: '格斗家(男)',
  gunner: '神枪手(男)',
  'at gunner': '神枪手(女)',
  atgunner: '神枪手(女)',
  mage: '魔法师(女)',
  'at mage': '魔法师(男)',
  atmage: '魔法师(男)',
  priest: '圣职者',
  thief: '暗夜使者',
  'demonic swordman': '黑暗武士',
  demonicswordman: '黑暗武士',
  'creator mage': '缔造者',
  creatormage: '缔造者',
  none: '未转职',
  weaponmaster: '剑魂',
  soulbringer: '鬼泣',
  berserker: '狂战士',
  asura: '阿修罗',
  ranger: '漫游枪手',
  launcher: '枪炮师',
  mechanic: '机械师',
  spitfire: '弹药专家',
  elementalmaster: '元素师',
  summoner: '召唤师',
  battlemage: '战斗法师',
  witch: '魔道学者',
  nenmaster: '气功师',
  striker: '散打',
  streetfighter: '街霸',
  grappler: '柔道家',
  crusader: '圣骑士',
  infighter: '蓝拳圣使',
  exorcist: '驱魔师',
  avenger: '复仇者',
  rogue: '刺客',
  necromancer: '死灵术士',
};

const TRADE_LABELS: Record<string, string> = {
  '[trade]': '无法交易',
  '[free]': '自由交易',
  '[sealing]': '封装',
  '[trade delete]': '无法交易/删除',
  '[account]': '账号绑定',
  '[sealing trade]': '封装且不可交易',
};

const KNOWN_PREVIEW_TAGS = new Set([
  ...BLOCK_VALUE_TAGS,
  'attach type',
  'basic explain',
  'basic explain ex',
  'cash',
  'casting time',
  'command key explain',
  'complete npc index',
  'consume mp',
  'cool time',
  'detail explain',
  'equipment magical attack',
  'equipment magical defense',
  'equipment physical attack',
  'equipment physical defense',
  'equipment type',
  'explain',
  'explain ex',
  'flavor text',
  'fullset basic explain',
  'fullset detail explain',
  'grade',
  'growtype maximum level',
  'icon',
  'icon pos',
  'index',
  'item group name',
  'job',
  'job message',
  'maximum level',
  'message',
  'minimum level',
  'name',
  'name2',
  'next skill',
  'npc',
  'npc index',
  'parameter basic explain',
  'parameter detail explain',
  'price',
  'rarity',
  'relation quest',
  'required level',
  'required level range',
  'reward type',
  'set name',
  'skill class',
  'skill command advantage',
  'stack limit',
  'stackable type',
  'start cool time',
  'tab name',
  'type',
  'use effect explain',
  'value',
  'weapon effect type',
  'weight',
  ...Object.keys(EQUIPMENT_STAT_LABELS),
  ...Object.keys(EQUIPMENT_MAGIC_LABELS),
]);

export class UnpackPreviewService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly lstCache = new Map<string, LstCacheEntry | undefined>();
  private readonly lstPromises = new Map<string, Promise<LstCacheEntry | undefined>>();
  private readonly tagTitlePromises = new Map<string, Promise<Map<string, PreviewTagTitle>>>();

  constructor(
    private readonly metadata: UnpackMetadataService,
    private readonly context: vscode.ExtensionContext,
    private readonly output?: { appendLine(value: string): void },
  ) {}

  clear(): void {
    this.cache.clear();
    this.lstCache.clear();
    this.lstPromises.clear();
    this.tagTitlePromises.clear();
  }

  invalidate(input: UnpackPreviewInput): void {
    const cacheKey = `${path.resolve(input.root)}\0${normalizeUnpackKey(input.key)}\0${input.version}`;
    this.cache.delete(cacheKey);
  }

  async resolvePreview(input: UnpackPreviewInput, options: UnpackPreviewOptions = {}): Promise<UnpackHoverPreview | undefined> {
    if (input.isDirectory || !input.key) return undefined;
    const shouldResolveIcon = options.resolveIcon === true;
    const kind = this.previewKind(input.key, '');
    if (!kind && !shouldProbePreviewText(input.key)) return undefined;
    try {
      const stat = await fs.stat(input.fsPath);
      if (!stat.isFile()) return undefined;
      const cacheKey = `${path.resolve(input.root)}\0${normalizeUnpackKey(input.key)}\0${input.version}`;
      const cached = this.cache.get(cacheKey);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && (!shouldResolveIcon || cached.iconSettled)) {
        return cached.preview;
      }

      const text = await readUtf8Text(input.fsPath);
      const resolvedKind = this.previewKind(input.key, text);
      if (!resolvedKind) return undefined;
      const metadata = shouldResolveUnpackMetadataKey(input.key)
        ? await this.metadata.resolveMetadata(input).catch(() => undefined)
        : undefined;
      let latestMetadata = this.metadata.getCached(input) || metadata;
      if (shouldResolveIcon && latestMetadata?.icon && !latestMetadata.iconDataUri) {
        await this.metadata.resolveIcon(input).catch((err: any) => {
          this.output?.appendLine(`[PVF] failed to resolve preview icon ${input.key}: ${String(err && err.message || err)}`);
          return undefined;
        });
        latestMetadata = this.metadata.getCached(input) || latestMetadata;
      }
      const preview = await this.buildPreview(input, text, resolvedKind, latestMetadata);
      this.cache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, iconSettled: previewIconSettled(latestMetadata, shouldResolveIcon), preview });
      return preview;
    } catch (err: any) {
      return this.errorPreview(input, String(err && err.message || err));
    }
  }

  private previewKind(key: string, text: string): UnpackPreviewKind | undefined {
    const normalized = normalizeUnpackKey(key);
    if (normalized.endsWith('.equ')) {
      return hasSetTags(text) ? 'equipmentSet' : 'equipment';
    }
    if (normalized.endsWith('.stk')) return 'stackable';
    if (normalized.endsWith('.shp')) return 'shop';
    if (normalized.endsWith('.qst')) return 'quest';
    if (normalized.endsWith('.skl')) return 'skill';
    if (isSkillTreeKey(normalized) || isSkillTreeText(text)) return 'skillTree';
    return undefined;
  }

  private async buildPreview(
    input: UnpackPreviewInput,
    text: string,
    kind: UnpackPreviewKind,
    metadata: UnpackResolvedMetadata | undefined,
  ): Promise<UnpackHoverPreview> {
    const tags = parseTags(text);
    switch (kind) {
      case 'equipmentSet': return this.buildEquipmentSetPreview(input, tags, metadata);
      case 'equipment': return this.buildEquipmentPreview(input, tags, metadata);
      case 'stackable': return this.buildStackablePreview(input, tags, metadata);
      case 'shop': return this.buildShopPreview(input, tags, metadata);
      case 'quest': return this.buildQuestPreview(input, tags, metadata);
      case 'skill': return this.buildSkillPreview(input, tags, metadata);
      case 'skillTree': return this.buildSkillTreePreview(input, text, tags, metadata);
      default: return this.errorPreview(input, '不支持的预览类型');
    }
  }

  private async buildEquipmentPreview(
    input: UnpackPreviewInput,
    tags: ParsedTags,
    metadata: UnpackResolvedMetadata | undefined,
  ): Promise<UnpackHoverPreview> {
    const sections: UnpackPreviewSection[] = [];
    const titles = await this.loadTagTitles('equ');
    const fields = compactFields([
      field('道具ID', numText(metadata?.itemCode)),
      tagField(titles, 'equipment type', '类型', labelToken(firstValue(tags, 'equipment type'))),
      tagField(titles, 'item group name', '物品组', cleanValue(firstValue(tags, 'item group name'))),
      tagField(titles, 'minimum level', '等级限制', levelText(firstNumber(tags, 'minimum level'))),
      tagField(titles, 'durability', '耐久度', numText(firstNumber(tags, 'durability'))),
      tagField(titles, 'weight', '重量', weightText(firstNumber(tags, 'weight'))),
      tagField(titles, 'attach type', '交易', tradeText(firstValue(tags, 'attach type'))),
      tagField(titles, 'value', '出售价格', priceText(firstNumber(tags, 'value'), 5)),
      tagField(titles, 'price', '价格', priceText(firstNumber(tags, 'price'))),
    ]);
    if (fields.length) sections.push({ title: '装备信息', fields });

    const jobs = tagLines(tags, 'usable job').map(line => labelToken(line)).filter(isString);
    if (jobs.length) sections.push({ title: '可使用职业', lines: [jobs.map(job => JOB_LABELS[job.toLowerCase()] || job).join('、')] });

    const baseStats = statFields(tags, EQUIPMENT_STAT_LABELS, false, titles);
    if (baseStats.length) sections.push({ title: '基础属性', fields: baseStats });

    const magicStats = statFields(tags, EQUIPMENT_MAGIC_LABELS, true, titles);
    if (magicStats.length) sections.push({ title: '特殊属性', fields: magicStats, tone: 'blue' });

    addTextSection(sections, '装备说明', explainLines(tags, 'basic explain', 'detail explain', 'explain'), 'blue');
    addTextSection(sections, '风味文本', explainLines(tags, 'flavor text'), 'flavor');

    return this.basePreview(input, metadata, 'equipment', displayTitle(input, tags, metadata), '装备', sections);
  }

  private async buildEquipmentSetPreview(
    input: UnpackPreviewInput,
    tags: ParsedTags,
    metadata: UnpackResolvedMetadata | undefined,
  ): Promise<UnpackHoverPreview> {
    const sections: UnpackPreviewSection[] = [];
    const setItems = numbersFromLines(tagLines(tags, 'set item')).filter(code => code >= 0);
    if (setItems.length) {
      const refs = await this.resolveEntries(setItems.map(code => ({ code })), input, ITEM_LSTS);
      sections.push({ title: '套装部件', entries: refs, tone: 'set' });
    }
    addTextSection(sections, '套装属性', tagLines(tags, 'set ability'), 'set');
    addTextSection(sections, '件数属性', tagLines(tags, 'piece set ability'), 'set');
    addTextSection(sections, '全套说明', explainLines(tags, 'fullset basic explain', 'fullset detail explain'), 'blue');
    addTextSection(sections, '参数说明', explainLines(tags, 'parameter basic explain', 'parameter detail explain'), 'blue');
    return this.basePreview(input, metadata, 'equipmentSet', cleanValue(firstValue(tags, 'set name')) || displayTitle(input, tags, metadata), '套装', sections);
  }

  private async buildStackablePreview(
    input: UnpackPreviewInput,
    tags: ParsedTags,
    metadata: UnpackResolvedMetadata | undefined,
  ): Promise<UnpackHoverPreview> {
    const sections: UnpackPreviewSection[] = [];
    const titles = await this.loadTagTitles('stk');
    const fields = compactFields([
      field('ID', numText(metadata?.itemCode)),
      tagField(titles, 'stackable type', '类型', labelToken(firstValue(tags, 'stackable type'))),
      tagField(titles, 'stack limit', '堆叠上限', numText(firstNumber(tags, 'stack limit'))),
      tagField(titles, 'minimum level', '等级限制', levelText(firstNumber(tags, 'minimum level'))),
      tagField(titles, 'attach type', '交易', tradeText(firstValue(tags, 'attach type'))),
      tagField(titles, 'value', '出售价格', priceText(firstNumber(tags, 'value'), 5)),
      tagField(titles, 'price', '价格', priceText(firstNumber(tags, 'price'))),
    ]);
    if (fields.length) sections.push({ title: '道具信息', fields });
    addTextSection(sections, '道具说明', explainLines(tags, 'explain', 'basic explain', 'detail explain', 'use effect explain'), 'blue');

    const packageCodes = parsePairedItemCodes(tagLines(tags, 'package data'));
    if (packageCodes.length) sections.push({ title: '礼包内容', entries: await this.resolveEntries(packageCodes, input, ITEM_LSTS), tone: 'shop' });

    const randomCodes = parseLooseItemEntries(tagLines(tags, 'random list', 'booster random', 'etc', 'output', 'result item'));
    if (randomCodes.length) sections.push({ title: '随机/产出内容', entries: await this.resolveEntries(randomCodes.slice(0, 32), input, ITEM_LSTS), tone: 'shop' });

    const materialCodes = parseLooseItemEntries(tagLines(tags, 'need material', 'material', 'condition item', 'a condition item', 'b condition item'));
    if (materialCodes.length) sections.push({ title: '材料/条件', entries: await this.resolveEntries(materialCodes.slice(0, 24), input, ITEM_LSTS) });

    addTextSection(sections, '附魔/特殊数据', tagLines(tags, 'enchant', 'monster card id', 'string data', 'stat change', 'stat change duration'), 'blue');
    addTextSection(sections, '风味文本', explainLines(tags, 'flavor text'), 'flavor');
    return this.basePreview(input, metadata, 'stackable', displayTitle(input, tags, metadata), '道具', sections);
  }

  private async buildShopPreview(
    input: UnpackPreviewInput,
    tags: ParsedTags,
    metadata: UnpackResolvedMetadata | undefined,
  ): Promise<UnpackHoverPreview> {
    const sections: UnpackPreviewSection[] = [];
    const titles = await this.loadTagTitles('shp');
    const fields = compactFields([
      field('代码', numText(metadata?.itemCode)),
      tagField(titles, 'message', '消息', cleanValue(firstValue(tags, 'message'))),
      tagField(titles, 'weapon shop', '商店类型', hasTag(tags, 'weapon shop') ? '武器商店' : undefined),
      tagField(titles, 'npc', 'NPC', cleanValue(firstValue(tags, 'npc'))),
    ]);
    if (fields.length) sections.push({ title: '商店信息', fields, tone: 'shop' });
    const tabs = tagLines(tags, 'tab name').map(cleanValue).filter(isString);
    if (tabs.length) sections.push({ title: '标签页', lines: tabs });

    const sellEntries = parseShopEntries(tagLines(tags, 'sell item'));
    if (sellEntries.length) {
      sections.push({ title: '出售商品', entries: await this.resolveEntries(sellEntries.slice(0, 80), input, ITEM_LSTS), tone: 'shop' });
    }
    const spendingEntries = parseLooseItemEntries(tagLines(tags, 'spending item', 'need material'));
    if (spendingEntries.length) {
      sections.push({ title: '兑换/消耗材料', entries: await this.resolveEntries(spendingEntries.slice(0, 40), input, ITEM_LSTS), tone: 'shop' });
    }
    return this.basePreview(input, metadata, 'shop', displayTitle(input, tags, metadata), 'NPC 商店', sections);
  }

  private async buildQuestPreview(
    input: UnpackPreviewInput,
    tags: ParsedTags,
    metadata: UnpackResolvedMetadata | undefined,
  ): Promise<UnpackHoverPreview> {
    const sections: UnpackPreviewSection[] = [];
    const titles = await this.loadTagTitles('qst');
    const fields = compactFields([
      field('代码', numText(metadata?.itemCode)),
      tagField(titles, 'type', '类型', labelToken(firstValue(tags, 'type'))),
      tagField(titles, 'reward type', '奖励类型', labelToken(firstValue(tags, 'reward type'))),
      tagField(titles, 'grade', '任务品级', metadata?.grade || labelToken(firstValue(tags, 'grade'))),
      tagField(titles, 'job', '职业', labelToken(firstValue(tags, 'job'))),
      tagField(titles, 'npc index', '接取 NPC', numText(firstNumber(tags, 'npc index'))),
      tagField(titles, 'complete npc index', '完成 NPC', numText(firstNumber(tags, 'complete npc index'))),
      tagField(titles, 'pre required quest', '前置任务', numText(firstNumber(tags, 'pre required quest'))),
      tagField(titles, 'relation quest', '关联任务', numText(firstNumber(tags, 'relation quest'))),
    ]);
    if (fields.length) sections.push({ title: '任务信息', fields, tone: 'quest' });
    addTextSection(sections, '任务说明', explainLines(tags, 'explain', 'basic explain', 'detail explain', 'depend message', 'job message'), 'quest');
    addTextSection(sections, '完成条件', tagLines(tags, 'int data', 'dungeon info', 'monster reward item', 'enemy reward item', 'clear reward item'), 'quest');

    const rewardEntries = [
      ...parsePairedItemCodes(tagLines(tags, 'reward int data')),
      ...parseQuestSelectionRewards(tagLines(tags, 'reward selection int data')),
    ];
    if (rewardEntries.length) {
      sections.push({ title: '任务奖励', entries: await this.resolveEntries(rewardEntries.slice(0, 60), input, ITEM_LSTS), tone: 'quest' });
    }
    return this.basePreview(input, metadata, 'quest', displayTitle(input, tags, metadata), '任务', sections);
  }

  private async buildSkillPreview(
    input: UnpackPreviewInput,
    tags: ParsedTags,
    metadata: UnpackResolvedMetadata | undefined,
  ): Promise<UnpackHoverPreview> {
    const sections: UnpackPreviewSection[] = [];
    const titles = await this.loadTagTitles('skl');
    const fields = compactFields([
      field('代码', numText(metadata?.itemCode)),
      tagField(titles, 'type', '类型', labelToken(firstValue(tags, 'type'))),
      tagField(titles, 'skill class', '技能类', cleanValue(firstValue(tags, 'skill class'))),
      tagField(titles, 'required level', '学习等级', levelText(firstNumber(tags, 'required level'))),
      tagField(titles, 'required level range', '等级间隔', numText(firstNumber(tags, 'required level range'))),
      tagField(titles, 'maximum level', '最高等级', numText(firstNumber(tags, 'maximum level'))),
      tagField(titles, 'cool time', '冷却时间', timeMsText(firstNumber(tags, 'cool time'))),
      tagField(titles, 'start cool time', '开始冷却', timeMsText(firstNumber(tags, 'start cool time'))),
      tagField(titles, 'consume mp', 'MP 消耗', rangeText(numbersFromLines(tagLines(tags, 'consume mp')))),
      tagField(titles, 'casting time', '施法时间', timeMsText(firstNumber(tags, 'casting time'), 100)),
      tagField(titles, 'weapon effect type', '伤害类型', labelToken(firstValue(tags, 'weapon effect type'))),
    ]);
    if (fields.length) sections.push({ title: '技能信息', fields, tone: 'skill' });
    addTextSection(sections, '技能说明', explainLines(tags, 'basic explain', 'explain', 'basic explain ex', 'explain ex'), 'skill');
    addTextSection(sections, '技能属性', tagLines(tags, 'level property', 'special level up'), 'blue');
    addTextSection(sections, '前置/消耗', tagLines(tags, 'pre required skill', 'consume item', 'purchase cost', 'special purchase cost'), 'skill');
    addTextSection(sections, '指令', tagLines(tags, 'command', 'command key explain', 'skill command advantage'), 'skill');
    addTextSection(sections, '特殊效果', tagLines(tags, 'static data', 'level info', 'skill under cooltime effect', 'skill under cooltime effect each'), 'blue');
    return this.basePreview(input, metadata, 'skill', displayTitle(input, tags, metadata), '技能', sections);
  }

  private async buildSkillTreePreview(
    input: UnpackPreviewInput,
    text: string,
    tags: ParsedTags,
    metadata: UnpackResolvedMetadata | undefined,
  ): Promise<UnpackHoverPreview> {
    const nodes = parseSkillTreeNodes(text);
    const treeType = skillTreeType(input.key);
    const job = firstSkillTreeJob(text) || labelToken(firstValue(tags, 'character job'));
    const lsts = skillLstsForJob(job);
    const titles = await this.loadTagTitles(skillTreeTagShort(input.key));
    const entries: UnpackPreviewEntry[] = [];
    let resolvedCount = 0;
    for (const node of nodes.slice(0, 120)) {
      const ref = await this.resolveCode(input, node.code, node.common ? COMMON_SKILL_LSTS : lsts);
      if (ref.key) resolvedCount++;
      entries.push({
        code: node.code,
        name: ref.name,
        key: ref.key,
        x: node.x,
        y: node.y,
        branch: node.branch,
        common: node.common,
        unresolved: !ref.key,
        icon: iconFromMetadata(ref.metadata),
        detail: node.nextSkills.length ? `关联: ${node.nextSkills.join(', ')}` : undefined,
      });
    }
    const fields = compactFields([
      field('类型', treeType),
      tagField(titles, 'character job', '职业', job ? labelJob(job) : undefined),
      field('节点数', String(nodes.length)),
      field('已解析', `${resolvedCount}/${nodes.length}`),
    ]);
    const sections: UnpackPreviewSection[] = [
      { title: '技能树信息', fields, tone: 'skill' },
      { title: '技能节点', entries, tone: 'skill' },
    ];
    return {
      ...this.basePreview(input, metadata, 'skillTree', skillTreeTitle(input, job), '技能树', sections),
      badges: [treeType],
      miniMap: {
        points: nodes
          .filter(node => typeof node.x === 'number' && typeof node.y === 'number')
          .slice(0, 160)
          .map(node => ({
            x: node.x || 0,
            y: node.y || 0,
            resolved: entries.some(entry => entry.code === node.code && !entry.unresolved),
            common: node.common,
            label: String(node.code),
          })),
      },
    };
  }

  private basePreview(
    input: UnpackPreviewInput,
    metadata: UnpackResolvedMetadata | undefined,
    kind: UnpackPreviewKind,
    title: string,
    subtitle: string,
    sections: UnpackPreviewSection[],
  ): UnpackHoverPreview {
    return {
      kind,
      title: title || input.name,
      subtitle,
      key: input.key,
      fsPath: input.fsPath,
      ...(typeof metadata?.itemCode === 'number' ? { itemCode: metadata.itemCode } : {}),
      ...(typeof metadata?.rarity === 'number' ? { rarity: metadata.rarity, rarityLabel: rarityLabel(metadata.rarity) } : {}),
      ...(iconFromMetadata(metadata) ? { icon: iconFromMetadata(metadata) } : {}),
      sections: sections.length ? sections : [{ title: '文件信息', fields: compactFields([field('路径', input.key)]) }],
    };
  }

  private errorPreview(input: UnpackPreviewInput, message: string): UnpackHoverPreview {
    return {
      kind: 'error',
      title: input.name,
      subtitle: '预览失败',
      key: input.key,
      fsPath: input.fsPath,
      message,
      sections: [{ title: '错误', lines: [message] }],
    };
  }

  private async loadTagTitles(short: string): Promise<PreviewTagTitles> {
    const normalized = short.toLowerCase();
    let promise = this.tagTitlePromises.get(normalized);
    if (!promise) {
      promise = this.readTagTitles(normalized);
      this.tagTitlePromises.set(normalized, promise);
    }
    return promise;
  }

  private async readTagTitles(short: string): Promise<Map<string, PreviewTagTitle>> {
    const candidates = [
      path.join(this.context.extensionUri.fsPath, 'dist', 'config', 'scriptLang', 'scriptTags', `${short}.json`),
      path.join(this.context.extensionUri.fsPath, 'src', 'config', 'scriptLang', 'scriptTags', `${short}.json`),
    ];
    for (const candidate of candidates) {
      try {
        const raw = await fs.readFile(candidate, 'utf8');
        const data = JSON.parse(raw) as ScriptTagTitleFile;
        const titles = new Map<string, PreviewTagTitle>();
        for (const tag of data.tags || []) {
          if (typeof tag.name !== 'string' || typeof tag.title !== 'string') continue;
          const title = tag.title.trim();
          const name = tag.name.trim();
          if (name && title) titles.set(name.toLowerCase(), { name, title });
        }
        return titles;
      } catch {
      }
    }
    return new Map<string, PreviewTagTitle>();
  }

  private async resolveEntries(
    values: Array<{ code: number; quantity?: number; detail?: string }>,
    input: UnpackPreviewInput,
    lstKeys: string[],
  ): Promise<UnpackPreviewEntry[]> {
    const entries: UnpackPreviewEntry[] = [];
    for (const value of values) {
      if (!Number.isSafeInteger(value.code)) continue;
      if (value.code === 0) {
        entries.push({ code: value.code, name: '金币', quantity: value.quantity, detail: value.detail });
        continue;
      }
      const ref = await this.resolveCode(input, value.code, lstKeys);
      entries.push({
        code: value.code,
        name: ref.name,
        key: ref.key,
        quantity: value.quantity,
        detail: value.detail,
        unresolved: !ref.key,
        icon: iconFromMetadata(ref.metadata),
      });
    }
    return entries;
  }

  private async resolveCode(input: UnpackPreviewInput, code: number, lstKeys: string[]): Promise<CodeReference> {
    for (const lstKey of lstKeys) {
      const lstPath = safeJoinArchivePath(input.root, lstKey);
      if (!lstPath) continue;
      const entry = await this.loadLst(lstPath);
      const key = entry?.codeToFile.get(code);
      if (!key) continue;
      const fsPath = safeJoinArchivePath(input.root, key);
      if (!fsPath) return { code, key };
      const refInput: UnpackPreviewInput = {
        fsPath,
        key,
        name: path.basename(fsPath),
        root: input.root,
        version: input.version,
      };
      let refMeta: UnpackResolvedMetadata | undefined;
      try {
        refMeta = await this.metadata.resolveMetadata(refInput);
      } catch (err: any) {
        this.output?.appendLine(`[PVF] failed to resolve preview reference ${code} -> ${key}: ${String(err && err.message || err)}`);
      }
      return {
        code,
        key,
        fsPath,
        name: refMeta?.itemName || path.basename(key),
        metadata: refMeta,
      };
    }
    return { code, unresolved: true };
  }

  private async loadLst(lstDiskPath: string): Promise<LstCacheEntry | undefined> {
    let stat: import('fs').Stats;
    try {
      stat = await fs.stat(lstDiskPath);
      if (!stat.isFile()) return undefined;
    } catch {
      return undefined;
    }
    const cached = this.lstCache.get(lstDiskPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
    const existing = this.lstPromises.get(lstDiskPath);
    if (existing) return existing;
    const promise = readLstFileToCodeMap(lstDiskPath)
      .then(fileToCode => {
        const codeToFile = new Map<number, string>();
        for (const [file, code] of fileToCode) {
          if (!codeToFile.has(code)) codeToFile.set(code, file);
        }
        const entry = { mtimeMs: stat.mtimeMs, size: stat.size, fileToCode, codeToFile };
        this.lstCache.set(lstDiskPath, entry);
        return entry;
      })
      .catch((err: any) => {
        this.output?.appendLine(`[PVF] failed to read preview lst ${lstDiskPath}: ${String(err && err.message || err)}`);
        this.lstCache.set(lstDiskPath, undefined);
        return undefined;
      })
      .finally(() => this.lstPromises.delete(lstDiskPath));
    this.lstPromises.set(lstDiskPath, promise);
    return promise;
  }
}

async function readUtf8Text(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  let text = Buffer.from(buf).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function safeJoinArchivePath(root: string, key: string): string | undefined {
  const parts = normalizeUnpackKey(key).split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '..' || part.includes('\0'))) return undefined;
  const fullPath = path.resolve(root, ...parts);
  const relative = path.relative(path.resolve(root), fullPath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? fullPath : undefined;
}

function parseTags(text: string): ParsedTags {
  const values = new Map<string, string[]>();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let current = '';
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const tag = trimmed.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (tag) {
      const name = tag[1].trim().toLowerCase();
      if (name.startsWith('/')) {
        current = '';
        continue;
      }
      if (current && (BLOCK_VALUE_TAGS.has(current) || !KNOWN_PREVIEW_TAGS.has(name))) {
        values.get(current)!.push(trimmed);
        continue;
      }
      current = name;
      if (!values.has(current)) values.set(current, []);
      if (tag[2]?.trim()) values.get(current)!.push(tag[2].trim());
      continue;
    }
    if (current && trimmed && !trimmed.startsWith('//')) values.get(current)!.push(trimmed);
  }
  return { values };
}

function hasTag(tags: ParsedTags, name: string): boolean {
  return tags.values.has(name.toLowerCase());
}

function tagLines(tags: ParsedTags, ...names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const values = tags.values.get(name.toLowerCase());
    if (values) out.push(...values.map(cleanValue).filter(isString));
  }
  return out;
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function firstValue(tags: ParsedTags, name: string): string | undefined {
  return tagLines(tags, name)[0];
}

function firstNumber(tags: ParsedTags, name: string): number | undefined {
  return numbersFromLines(tagLines(tags, name))[0];
}

function cleanValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let text = value.trim();
  const linkText = text.match(/`([^`]*)`/);
  if (linkText) text = linkText[1];
  text = text.replace(/^`+|`+$/g, '').replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '').trim();
  return text || undefined;
}

function labelToken(value: string | undefined): string | undefined {
  const cleaned = cleanValue(value);
  if (!cleaned) return undefined;
  return cleaned.replace(/^\[|\]$/g, '').trim();
}

function labelJob(value: string): string {
  const normalized = labelToken(value)?.toLowerCase() || value.toLowerCase();
  return JOB_LABELS[normalized] || value;
}

function numbersFromLines(lines: string[]): number[] {
  const out: number[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(/-?\d+/g)) {
      const n = Number(match[0]);
      if (Number.isSafeInteger(n)) out.push(n);
    }
  }
  return out;
}

function statFields(tags: ParsedTags, labels: Record<string, string>, signed: boolean, titles?: PreviewTagTitles): UnpackPreviewField[] {
  const fields: UnpackPreviewField[] = [];
  for (const [tag, label] of Object.entries(labels)) {
    const value = firstNumber(tags, tag);
    if (typeof value !== 'number') continue;
    fields.push({ ...tagLabel(titles, tag, label), value: signedNumber(value, signed), tone: signed ? 'magic' : 'normal' });
  }
  return fields;
}

function signedNumber(value: number, signed: boolean): string {
  if (!signed) return `+${value}`;
  return value > 0 ? `+${value}` : String(value);
}

function field(label: string, value: string | undefined, tone?: UnpackPreviewField['tone']): UnpackPreviewField | undefined {
  return value ? { label, value, ...(tone ? { tone } : {}) } : undefined;
}

function tagField(titles: PreviewTagTitles | undefined, tag: string, fallbackLabel: string, value: string | undefined, tone?: UnpackPreviewField['tone']): UnpackPreviewField | undefined {
  if (!value) return undefined;
  return { ...tagLabel(titles, tag, fallbackLabel), value, ...(tone ? { tone } : {}) };
}

function tagTitle(titles: PreviewTagTitles | undefined, tag: string, fallbackLabel: string): string {
  return tagLabel(titles, tag, fallbackLabel).label;
}

function tagLabel(titles: PreviewTagTitles | undefined, tag: string, fallbackLabel: string): Pick<UnpackPreviewField, 'label' | 'tagName'> {
  const entry = titles?.get(tag.toLowerCase());
  return {
    label: entry?.title || fallbackLabel,
    tagName: entry?.name || tag,
  };
}

function compactFields(fields: Array<UnpackPreviewField | undefined>): UnpackPreviewField[] {
  return fields.filter((item): item is UnpackPreviewField => !!item);
}

function numText(value: number | undefined): string | undefined {
  return typeof value === 'number' ? String(value) : undefined;
}

function levelText(value: number | undefined): string | undefined {
  return typeof value === 'number' ? `Lv.${value}` : undefined;
}

function weightText(value: number | undefined): string | undefined {
  return typeof value === 'number' ? `${trimNumber(value / 1000)}kg` : undefined;
}

function priceText(value: number | undefined, divisor = 1): string | undefined {
  return typeof value === 'number' ? `${Math.floor(value / divisor)} 金币` : undefined;
}

function timeMsText(value: number | undefined, divisor = 1000): string | undefined {
  return typeof value === 'number' ? `${trimNumber(value / divisor)} 秒` : undefined;
}

function rangeText(values: number[]): string | undefined {
  if (values.length === 0) return undefined;
  if (values.length === 1) return String(values[0]);
  return `${values[0]} - ${values[values.length - 1]}`;
}

function trimNumber(value: number): string {
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function tradeText(value: string | undefined): string | undefined {
  const token = cleanValue(value);
  if (!token) return undefined;
  const normalized = token.startsWith('[') ? token.toLowerCase() : `[${token.toLowerCase()}]`;
  return TRADE_LABELS[normalized] || token;
}

function addTextSection(sections: UnpackPreviewSection[], title: string, lines: string[], tone?: UnpackPreviewSection['tone']): void {
  const cleaned = lines.map(line => line.replace(/\\n/g, '\n').trim()).filter(Boolean);
  if (cleaned.length) sections.push({ title, lines: cleaned.slice(0, 80), ...(tone ? { tone } : {}) });
}

function explainLines(tags: ParsedTags, ...names: string[]): string[] {
  return tagLines(tags, ...names).flatMap(line => line.split(/\n/)).map(line => line.trim()).filter(Boolean);
}

function displayTitle(input: UnpackPreviewInput, tags: ParsedTags, metadata: UnpackResolvedMetadata | undefined): string {
  return metadata?.itemName
    || cleanValue(firstValue(tags, 'name'))
    || cleanValue(firstValue(tags, 'name2'))
    || cleanValue(firstValue(tags, 'set name'))
    || path.basename(input.name, path.extname(input.name));
}

function iconFromMetadata(metadata: UnpackResolvedMetadata | undefined): UnpackPreviewIcon | undefined {
  if (!metadata?.iconDataUri) return undefined;
  return {
    src: metadata.iconDataUri,
    ...(metadata.iconWidth ? { width: metadata.iconWidth } : {}),
    ...(metadata.iconHeight ? { height: metadata.iconHeight } : {}),
    ...(metadata.icon?.imagePath.endsWith('interface/quest/quest_tag.img') ? { isQuestTag: true } : {}),
  };
}

function previewIconSettled(metadata: UnpackResolvedMetadata | undefined, requested: boolean): boolean {
  if (!requested) return false;
  if (!metadata?.icon) return true;
  return !!metadata.iconDataUri || metadata.iconState === 'missing' || metadata.iconState === 'error' || metadata.iconState === 'ready';
}

function hasSetTags(text: string): boolean {
  return /\[(set name|set item|set ability|piece set ability|fullset basic explain|fullset detail explain|part set index)\]/i.test(text);
}

function isSkillTreeKey(key: string): boolean {
  return /^clientonly\/skilltree\/.+_(sp|tp)\.co$/i.test(key)
    || /^clientonly\/skillshoptree(sp|tp)index\.co$/i.test(key)
    || /^etc\/pvpskilltree\/.+\.etc$/i.test(key);
}

function shouldProbePreviewText(key: string): boolean {
  return /\.(co|etc)$/i.test(normalizeUnpackKey(key));
}

function isSkillTreeText(text: string): boolean {
  return /\[character job\]/i.test(text) && /\[skill info\]/i.test(text) && /\[icon pos\]/i.test(text);
}

function skillTreeTagShort(key: string): string {
  return normalizeUnpackKey(key).endsWith('.etc') ? 'etc' : 'co';
}

function parsePairedItemCodes(lines: string[]): Array<{ code: number; quantity?: number; detail?: string }> {
  const out: Array<{ code: number; quantity?: number; detail?: string }> = [];
  for (const line of lines) {
    const nums = numbersFromLines([line]);
    for (let i = 0; i < nums.length; i += 2) {
      const code = nums[i];
      if (!Number.isSafeInteger(code) || code < 0) continue;
      out.push({ code, quantity: Number.isSafeInteger(nums[i + 1]) ? nums[i + 1] : undefined });
    }
  }
  return out;
}

function parseLooseItemEntries(lines: string[]): Array<{ code: number; quantity?: number; detail?: string }> {
  const out: Array<{ code: number; quantity?: number; detail?: string }> = [];
  for (const line of lines) {
    const nums = numbersFromLines([line]);
    if (!nums.length) continue;
    const code = nums.find(n => n >= 0);
    if (typeof code !== 'number') continue;
    const quantity = nums.length > 1 ? nums[1] : undefined;
    out.push({ code, quantity, detail: cleanValue(line) });
  }
  return dedupeEntries(out);
}

function parseShopEntries(lines: string[]): Array<{ code: number; quantity?: number; detail?: string }> {
  const entries: Array<{ code: number; quantity?: number; detail?: string }> = [];
  for (const line of lines) {
    const nums = numbersFromLines([line]).filter(n => n !== -1 && n !== -2);
    if (!nums.length) continue;
    const code = nums[0];
    if (code >= 0) entries.push({ code, quantity: nums[1], detail: cleanValue(line) });
  }
  return dedupeEntries(entries);
}

function parseQuestSelectionRewards(lines: string[]): Array<{ code: number; quantity?: number; detail?: string }> {
  const entries: Array<{ code: number; quantity?: number; detail?: string }> = [];
  for (const line of lines) {
    const nums = numbersFromLines([line]);
    if (nums.length >= 5 && /\[job\]/i.test(line)) {
      entries.push({ code: nums[0], quantity: nums[4], detail: cleanValue(line) });
      continue;
    }
    for (let i = 0; i < nums.length; i += 2) {
      if (nums[i] >= 0) entries.push({ code: nums[i], quantity: nums[i + 1], detail: cleanValue(line) });
    }
  }
  return dedupeEntries(entries);
}

function dedupeEntries<T extends { code: number; quantity?: number; detail?: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of entries) {
    const key = `${entry.code}\0${entry.quantity ?? ''}\0${entry.detail ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function parseSkillTreeNodes(text: string): SkillTreeNode[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const nodes: SkillTreeNode[] = [];
  let currentJob = '';
  let currentBranch = '';
  let inCharacterJob = false;
  let inSkillInfo = false;
  let currentTag = '';
  let node: SkillTreeNode | undefined;

  const flush = () => {
    if (node && Number.isSafeInteger(node.code)) nodes.push(node);
    node = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    const tag = line.match(/^\[([^\]]+)\]$/);
    if (tag) {
      const name = tag[1].trim().toLowerCase();
      if (name === 'character job') {
        inCharacterJob = true;
        currentJob = '';
        currentBranch = '';
        currentTag = '';
        continue;
      }
      if (name === '/character job') {
        flush();
        inCharacterJob = false;
        inSkillInfo = false;
        currentTag = '';
        continue;
      }
      if (name === 'skill info' || name === 'common skill') {
        flush();
        inSkillInfo = true;
        node = { code: -1, branch: currentBranch, common: name === 'common skill', nextSkills: [] };
        currentTag = '';
        continue;
      }
      if (name === '/skill info' || name === '/common skill') {
        flush();
        inSkillInfo = false;
        currentTag = '';
        continue;
      }
      currentTag = name;
      continue;
    }
    if (!inCharacterJob) continue;
    const cleaned = labelToken(line) || cleanValue(line) || line;
    if (!currentJob && /^\[?[a-z ]+\]?$/i.test(cleaned)) {
      currentJob = cleaned;
      continue;
    }
    if (!currentBranch && currentJob && /^\[?[a-z ]+\]?$/i.test(cleaned)) {
      currentBranch = cleaned;
      if (node) node.branch = currentBranch;
      continue;
    }
    if (!inSkillInfo || !node) continue;
    const nums = numbersFromLines([line]);
    if (currentTag === 'index' && nums.length) node.code = nums[0];
    else if (currentTag === 'icon pos' && nums.length >= 2) {
      node.x = nums[0];
      node.y = nums[1];
    } else if (currentTag === 'next skill' && nums.length) {
      node.nextSkills.push(...nums.filter(n => n >= 0));
    }
  }
  flush();
  return nodes.filter(item => item.code >= 0);
}

function firstSkillTreeJob(text: string): string | undefined {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let inCharacterJob = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^\[character job\]$/i.test(line)) {
      inCharacterJob = true;
      continue;
    }
    if (inCharacterJob && line && !line.startsWith('[')) return labelToken(line) || cleanValue(line);
  }
  return undefined;
}

function skillLstsForJob(job: string | undefined): string[] {
  const normalized = (labelToken(job) || job || '').toLowerCase();
  return [...(SKILL_LISTS_BY_JOB[normalized] || []), ...COMMON_SKILL_LSTS];
}

function skillTreeType(key: string): string {
  const normalized = normalizeUnpackKey(key);
  if (normalized.includes('/pvpskilltree/')) return 'PVP';
  if (normalized.endsWith('_tp.co') || normalized.includes('treetp')) return 'TP';
  if (normalized.endsWith('_sp.co') || normalized.includes('treesp')) return 'SP';
  return '未知';
}

function skillTreeTitle(input: UnpackPreviewInput, job: string | undefined): string {
  const type = skillTreeType(input.key);
  const jobText = job ? labelJob(job) : path.basename(input.name, path.extname(input.name));
  return `${jobText} ${type} 技能树`;
}
