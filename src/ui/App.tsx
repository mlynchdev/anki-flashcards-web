import { useEffect } from 'preact/hooks';
import { useRoute, useToast, applyTheme, col } from './state';
import { Icon } from './components';
import { DeckList } from './DeckList';
import { Study } from './Study';
import { Browse, SearchHelp } from './Browse';
import { AddScreen, EditScreen } from './Editor';
import { ImportScreen } from './Import';
import { SettingsScreen, ShortcutsHelp } from './Settings';
import { DeckOptions, Presets } from './DeckOptions';
import { CustomStudy, FilteredDeckEditor } from './Filtered';
import { NotetypeEditor, NotetypesScreen, TagsScreen } from './Manage';
import { CardInfo } from './CardInfo';
import { Stats } from './Stats';

const TABS = [
  { path: '', icon: 'decks', label: 'Decks' },
  { path: 'add', icon: 'add', label: 'Add' },
  { path: 'browse', icon: 'browse', label: 'Browse' },
  { path: 'stats', icon: 'stats', label: 'Stats' },
  { path: 'settings', icon: 'settings', label: 'Settings' },
];

export function App() {
  const route = useRoute();
  const [toastState, closeToast] = useToast();
  const [head, a, b] = route.path;

  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => applyTheme();
    mq.addEventListener('change', on);
    // Day rollover while the app stays open.
    const t = setInterval(() => col.checkDayRollover(), 60_000);
    return () => {
      mq.removeEventListener('change', on);
      clearInterval(t);
    };
  }, []);

  let screen;
  switch (head ?? '') {
    case '':
      screen = <DeckList />;
      break;
    case 'study':
      screen = <Study key={a} deckId={Number(a)} />;
      break;
    case 'browse':
      screen = <Browse />;
      break;
    case 'add':
      screen = <AddScreen deckId={route.query.get('deck') ? Number(route.query.get('deck')) : undefined} />;
      break;
    case 'edit':
      screen = <EditScreen key={a} noteId={Number(a)} />;
      break;
    case 'info':
      screen = <CardInfo cardId={Number(a)} />;
      break;
    case 'stats':
      screen = <Stats />;
      break;
    case 'settings':
      screen = <SettingsScreen />;
      break;
    case 'import':
      screen = <ImportScreen />;
      break;
    case 'options':
      screen = <DeckOptions key={a} deckId={Number(a)} />;
      break;
    case 'presets':
      screen = <Presets />;
      break;
    case 'filtered':
      screen = <FilteredDeckEditor key={a} deckId={a === 'new' ? undefined : Number(a)} />;
      break;
    case 'custom-study':
      screen = <CustomStudy deckId={Number(a)} />;
      break;
    case 'tags':
      screen = <TagsScreen />;
      break;
    case 'notetypes':
      screen = <NotetypesScreen />;
      break;
    case 'notetype':
      screen = <NotetypeEditor id={Number(a)} />;
      break;
    case 'help':
      screen = a === 'shortcuts' ? <ShortcutsHelp /> : <SearchHelp />;
      break;
    default:
      screen = <DeckList />;
  }
  void b;

  const hideTabs = head === 'study' || head === 'add' || head === 'edit';
  return (
    <>
      {screen}
      {!hideTabs && (
        <nav class="tabbar" aria-label="Main">
          <div class="tabbar-inner">
            {TABS.map((t) => (
              <a href={`#/${t.path}`} class={(head ?? '') === t.path ? 'active' : ''}>
                <Icon name={t.icon} />
                {t.label}
              </a>
            ))}
          </div>
        </nav>
      )}
      {toastState && (
        <div class="toast" role="status">
          <span>{toastState.msg}</span>
          {toastState.action && (
            <button
              onClick={() => {
                toastState.action!.run();
                closeToast();
              }}
            >
              {toastState.action.label}
            </button>
          )}
        </div>
      )}
    </>
  );
}
