export const NEWS_SPHERES = [
  { id: 'it', label: 'IT / технологии' },
  { id: 'ai', label: 'ИИ / нейросети' },
  { id: 'games', label: 'Игры' },
  { id: 'movies', label: 'Кино и сериалы' },
  { id: 'music', label: 'Музыка' },
  { id: 'science', label: 'Наука' },
  { id: 'space', label: 'Космос' },
  { id: 'gadgets', label: 'Гаджеты' },
  { id: 'startups', label: 'Стартапы / бизнес-tech' },
  { id: 'memes', label: 'Мемы и интернет-культура' },
  { id: 'sport', label: 'Спорт' },
  { id: 'auto', label: 'Авто' },
  { id: 'travel', label: 'Путешествия' },
  { id: 'food', label: 'Еда' },
  { id: 'design', label: 'Дизайн / UX' },
] as const;

export type NewsSphereId = (typeof NEWS_SPHERES)[number]['id'];

const SPHERE_IDS = new Set<string>(NEWS_SPHERES.map((s) => s.id));
const LABEL_BY_ID = new Map<NewsSphereId, string>(NEWS_SPHERES.map((s) => [s.id, s.label]));

export function isNewsSphereId(value: string): value is NewsSphereId {
  return SPHERE_IDS.has(value);
}

export function sphereLabel(id: NewsSphereId): string {
  return LABEL_BY_ID.get(id) ?? id;
}

export function sanitizeSpheres(values: readonly string[]): NewsSphereId[] {
  const seen = new Set<NewsSphereId>();
  const result: NewsSphereId[] = [];
  for (const value of values) {
    if (!isNewsSphereId(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function pickRandomSphere(
  spheres: readonly NewsSphereId[],
  random = Math.random,
): NewsSphereId | undefined {
  if (!spheres.length) return;
  return spheres[Math.floor(random() * spheres.length)]!;
}
