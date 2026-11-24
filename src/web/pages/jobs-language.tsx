export const languageOptions = [
  'en',
  'ar',
  'ar-EG',
  'fr',
  'de',
  'es',
  'pt',
  'it',
  'nl',
  'tr',
  'ru',
  'hi',
  'ur',
  'zh',
  'ja',
];
const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
export const languageName = (tag: string) => {
  try {
    return languageNames.of(tag) ?? tag;
  } catch {
    return tag;
  }
};
const rtlLanguages = new Set(['ar', 'ckb', 'dv', 'fa', 'he', 'ps', 'sd', 'ug', 'ur', 'yi']);
export const textDirection = (tag: string) =>
  !tag.trim() ? 'auto' : rtlLanguages.has(tag.trim().split('-')[0]!.toLowerCase()) ? 'rtl' : 'ltr';

export function languageSelect(
  value: string,
  custom: boolean,
  taken: string[],
  onPick: (tag: string | null) => void,
) {
  return (
    <select
      className="input"
      value={custom ? 'other' : value}
      onChange={(event) => onPick(event.target.value === 'other' ? null : event.target.value)}
    >
      {!custom && !languageOptions.includes(value) && (
        <option value={value} disabled>
          {value ? languageName(value) : 'Choose a language'}
        </option>
      )}
      {languageOptions.map((tag) => (
        <option key={tag} value={tag} disabled={taken.includes(tag)}>
          {languageName(tag)}
        </option>
      ))}
      <option value="other">Other language…</option>
    </select>
  );
}
