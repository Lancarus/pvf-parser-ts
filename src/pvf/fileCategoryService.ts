interface FileCategory {
  icon: string;
  color: string;
  label: string;
}

const extMap: Record<string, FileCategory> = {
  '.equ':  { icon: '\u2B26', color: '#4EC9B0', label: '装备' },
  '.skl':  { icon: '\u2605', color: '#569CD6', label: '技能' },
  '.stk':  { icon: '\u25C7', color: '#9CDCFE', label: '消耗品' },
  '.lst':  { icon: '\u2261', color: '#6A9955', label: '列表' },
  '.ani':  { icon: '\u25B8', color: '#D7BA7D', label: '动画' },
  '.chr':  { icon: '\u265B', color: '#C586C0', label: '角色' },
  '.npc':  { icon: '\u25CE', color: '#C586C0', label: 'NPC' },
  '.cre':  { icon: '\u2662', color: '#9CDCFE', label: '宠物' },
  '.dgn':  { icon: '\u25C8', color: '#CE9178', label: '地下城' },
  '.map':  { icon: '\u25A3', color: '#DCDCAA', label: '地图' },
  '.nut':  { icon: '\u2699', color: '#808080', label: '脚本' },
  '.ai':   { icon: '\u25C9', color: '#DCDCAA', label: 'AI' },
  '.aic':  { icon: '\u25C9', color: '#DCDCAA', label: 'AI编译' },
  '.qst':  { icon: '\u25AA', color: '#CE9178', label: '任务' },
  '.etc':  { icon: '\u2601', color: '#808080', label: '配置' },
  '.act':  { icon: '\u25B6', color: '#D7BA7D', label: '动作' },
  '.obj':  { icon: '\u25C7', color: '#4EC9B0', label: '对象' },
  '.str':  { icon: '\u00A7', color: '#6A9955', label: '字符串' },
  '.key':  { icon: '\u26BF', color: '#569CD6', label: '键值' },
};

const dirMap: Record<string, string> = {
  equipment: '装备', skill: '技能', stackable: '消耗品',
  character: '角色', monster: '怪物', npc: 'NPC',
  dungeon: '地下城', map: '地图', etc: '配置',
  creature: '宠物', aicharacter: 'AI角色', quest: '任务',
  n_quest: '任务', item: '物品', clientonly: '客户端',
  sqr: '资源', script: '脚本', event: '事件',
  interfaces: '界面', sound: '声音', video: '视频',
};

const firstCategory: FileCategory = { icon: '\u25A1', color: '#808080', label: '' };

export function getFileCategory(name: string): FileCategory {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot >= 0) {
    const ext = lower.substring(dot);
    if (extMap[ext]) return extMap[ext];
  }
  return firstCategory;
}

export function getDirLabel(name: string): string {
  return dirMap[name.toLowerCase()] || '';
}
