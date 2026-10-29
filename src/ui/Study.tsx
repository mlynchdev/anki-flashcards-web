import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { col, navigate, toast, useCol } from './state';
import { type Card, CardState, FLAG_COLORS, FLAG_NAMES, type GestureAction, type Rating } from '../core/types';
import type { NextCard, StudySession } from '../core/collection';
import { renderCard } from '../core/template';
import { formatInterval } from '../core/time';
import { CardView, replayAudio } from './CardView';
import { actionSheet, choose, confirm, Icon, prompt } from './components';
import { NoteEditor } from './Editor';
import { CardInfo } from './CardInfo';

const RATING_NAMES: Record<Rating, string> = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };
const RATING_CLASS: Record<Rating, string> = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };
const MAX_ANSWER_MS = 60_000;

export function Study({ deckId }: { deckId: number }) {
  useCol();
  const session = useMemo<StudySession>(() => col.startSession(deckId), [deckId]);
  const [next, setNext] = useState<NextCard>(() => col.nextCard(session));
  const [showAnswer, setShowAnswer] = useState(false);
  const [overlay, setOverlay] = useState<null | { kind: 'edit' | 'info'; card: Card }>(null);
  const shownAt = useRef(Date.now());
  const areaRef = useRef<HTMLDivElement>(null);
  const deck = col.decks.get(deckId);

  const card = next.kind === 'card' ? col.cards.get(next.card.id) ?? next.card : null;

  const advance = useCallback(() => {
    setNext(col.nextCard(session));
    setShowAnswer(false);
    shownAt.current = Date.now();
    areaRef.current?.scrollTo(0, 0);
  }, [session]);

  // Re-check when waiting for learning cards.
  useEffect(() => {
    if (next.kind !== 'wait') return;
    const ms = Math.max(1000, next.until - Date.now() - col.settings.learnAheadMins * 60_000);
    const t = setTimeout(advance, Math.min(ms, 30_000));
    return () => clearTimeout(t);
  }, [next, advance]);

  const note = card ? col.notes.get(card.noteId) : undefined;
  const nt = note ? col.notetypes.get(note.notetypeId) : undefined;
  const rendered = useMemo(() => {
    if (!card || !note || !nt) return null;
    const d = col.decks.get(card.odid ?? card.deckId);
    return renderCard(nt, note.fields, card.ord, { tags: note.tags, deck: d?.name ?? '' });
  }, [card?.id, note?.mod, nt?.mod, card?.ord]);

  const previews = useMemo(() => (card ? col.previews(card) : null), [card?.id, card?.mod, showAnswer]);
  const counts = col.counts(deckId, session);

  const answer = (rating: Rating) => {
    if (!card || !showAnswer) return;
    col.answer(card.id, rating, Math.min(Date.now() - shownAt.current, MAX_ANSWER_MS), session);
    const leech = col.hasTag(card.noteId, 'leech') && !note?.tags.includes('leech');
    if (leech) toast(col.cards.get(card.id)?.suspended ? 'Card is a leech and was suspended' : 'Card is a leech');
    advance();
  };

  const undo = () => {
    const entry = col.undo();
    if (!entry) return toast('Nothing to undo');
    toast(`Undid ${entry.label}`);
    if (entry.cardId && col.cards.has(entry.cardId)) {
      session.answered = Math.max(0, session.answered - 1);
      setNext({ kind: 'card', card: col.cards.get(entry.cardId)!, queue: 'review' });
      setShowAnswer(false);
      shownAt.current = Date.now();
    } else advance();
  };

  const withUndo = (msg: string) => toast(msg, { label: 'Undo', run: undo });

  const actions = {
    bury: () => {
      if (!card) return;
      col.bury([card.id]);
      withUndo('Card buried');
      advance();
    },
    buryNote: () => {
      if (!card) return;
      col.bury(col.siblings(card.id));
      withUndo('Note buried');
      advance();
    },
    suspend: () => {
      if (!card) return;
      col.setSuspended([card.id], true);
      withUndo('Card suspended');
      advance();
    },
    suspendNote: () => {
      if (!card) return;
      col.setSuspended(col.siblings(card.id), true);
      withUndo('Note suspended');
      advance();
    },
    mark: () => {
      if (!card) return;
      col.toggleMark(card.noteId);
      toast(col.hasTag(card.noteId, 'marked') ? 'Note marked' : 'Note unmarked');
    },
    flag: async () => {
      if (!card) return;
      const f = await choose(
        'Flag card',
        FLAG_NAMES.map((name, value) => ({ label: `${value ? '● ' : ''}${name}`, value })),
      );
      if (f !== null) col.setFlag([card.id], f);
    },
    setFlag: (f: number) => card && col.setFlag([card.id], card.flag === f ? 0 : f),
    edit: () => card && setOverlay({ kind: 'edit', card }),
    info: () => card && setOverlay({ kind: 'info', card }),
    replay: () => replayAudio(areaRef.current),
    deleteNote: async () => {
      if (!card) return;
      if (!(await confirm('Delete note?', 'The note and all its cards will be deleted.', 'Delete', true))) return;
      col.deleteNotes([card.noteId]);
      withUndo('Note deleted');
      advance();
    },
    forget: () => {
      if (!card) return;
      col.forget([card.id]);
      withUndo('Card reset to new');
      advance();
    },
    setDue: async () => {
      if (!card) return;
      const v = await prompt('Set due date', '1', { message: 'Days from today (0 = today)', type: 'number' });
      if (v === null || !Number.isFinite(Number(v))) return;
      col.setDueDate([card.id], Math.max(0, Math.round(Number(v))));
      withUndo('Due date set');
      advance();
    },
  };

  const runGesture = (g: GestureAction) => {
    switch (g) {
      case 'showAnswer':
        if (!showAnswer) setShowAnswer(true);
        return;
      case 'again':
        return showAnswer ? answer(1) : setShowAnswer(true);
      case 'hard':
        return showAnswer ? answer(2) : setShowAnswer(true);
      case 'good':
        return showAnswer ? answer(3) : setShowAnswer(true);
      case 'easy':
        return showAnswer ? answer(4) : setShowAnswer(true);
      case 'undo':
        return undo();
      case 'bury':
        return actions.bury();
      case 'suspend':
        return actions.suspend();
      case 'mark':
        return actions.mark();
      case 'flag':
        return void actions.flag();
      case 'edit':
        return actions.edit();
      case 'info':
        return actions.info();
      case 'replay':
        return actions.replay();
    }
  };

  // Keyboard shortcuts (desktop).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (overlay || document.querySelector('.backdrop')) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = e.key;
      if ((e.ctrlKey || e.metaKey) && /^[0-7]$/.test(k)) {
        e.preventDefault();
        actions.setFlag(Number(k));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') {
        e.preventDefault();
        return undo();
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (k === ' ' || k === 'Enter') {
        e.preventDefault();
        if (!card) return;
        return showAnswer ? answer(3) : setShowAnswer(true);
      }
      if (/^[1-4]$/.test(k)) {
        if (showAnswer) answer(Number(k) as Rating);
        return;
      }
      switch (k) {
        case 'u':
        case 'z':
          return undo();
        case 'e':
          return actions.edit();
        case 'i':
        case 'I':
          return actions.info();
        case '-':
          return actions.bury();
        case '=':
          return actions.buryNote();
        case '@':
          return actions.suspend();
        case '!':
          return actions.suspendNote();
        case '*':
          return actions.mark();
        case 'r':
        case 'F5':
          return actions.replay();
        case 'Escape':
          return navigate('', true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Tap zones and swipes on the card area.
  const touch = useRef<{ x: number; y: number; t: number; moved: boolean } | null>(null);
  const [swipe, setSwipe] = useState<{ dir: 'left' | 'right' | 'up' | 'down'; strength: number } | null>(null);
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    touch.current = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
  };
  const onPointerMove = (e: PointerEvent) => {
    const s = touch.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) s.moved = true;
    if (e.pointerType === 'mouse') return;
    const horiz = Math.abs(dx) > Math.abs(dy);
    const dist = horiz ? Math.abs(dx) : Math.abs(dy);
    if (dist > 30) setSwipe({ dir: horiz ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up', strength: Math.min(1, dist / 90) });
    else setSwipe(null);
  };
  const onPointerUp = (e: PointerEvent) => {
    const s = touch.current;
    touch.current = null;
    setSwipe(null);
    if (!s || !card) return;
    const target = e.composedPath()[0] as HTMLElement;
    if (target?.closest?.('a, audio, details, summary, button')) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    const area = areaRef.current!;
    if (s.moved && e.pointerType !== 'mouse') {
      const horiz = Math.abs(dx) > Math.abs(dy) * 1.3;
      const vert = Math.abs(dy) > Math.abs(dx) * 1.3;
      const scrollable = area.scrollHeight > area.clientHeight + 4;
      if (horiz && Math.abs(dx) >= 90) return runGesture(col.settings.swipe[dx > 0 ? 'right' : 'left']);
      if (vert && !scrollable && Math.abs(dy) >= 90) return runGesture(col.settings.swipe[dy > 0 ? 'down' : 'up']);
      return;
    }
    if (s.moved || Date.now() - s.t > 600) return;
    if (window.getSelection()?.toString()) return;
    const rect = area.getBoundingClientRect();
    const third = (e.clientX - rect.left) / rect.width;
    const zone = third < 1 / 3 ? 'left' : third > 2 / 3 ? 'right' : 'center';
    runGesture((showAnswer ? col.settings.tapAnswer : col.settings.tapQuestion)[zone]);
  };

  const menu = () =>
    actionSheet(undefined, [
      { label: 'Edit note', run: actions.edit, hidden: !card },
      { label: 'Card info', run: actions.info, hidden: !card },
      { label: 'Flag…', run: () => void actions.flag(), hidden: !card },
      { label: card && col.hasTag(card.noteId, 'marked') ? 'Unmark note' : 'Mark note', run: actions.mark, hidden: !card },
      { label: 'Bury card', run: actions.bury, hidden: !card },
      { label: 'Bury note', run: actions.buryNote, hidden: !card },
      { label: 'Suspend card', run: actions.suspend, hidden: !card },
      { label: 'Suspend note', run: actions.suspendNote, hidden: !card },
      { label: 'Set due date…', run: () => void actions.setDue(), hidden: !card },
      { label: 'Reset card to new', run: actions.forget, hidden: !card },
      { label: 'Replay audio', run: actions.replay, hidden: !card },
      { label: col.undoLabel ? `Undo ${col.undoLabel}` : 'Undo', run: undo, hidden: !col.undoLabel },
      { label: 'Deck options', run: () => navigate(`options/${card?.odid ?? deckId}`) },
      { label: 'Delete note', run: () => void actions.deleteNote(), destructive: true, hidden: !card },
    ]);

  const queue = next.kind === 'card' ? next.queue : null;
  const countEl = (
    <div class="study-counts" aria-label="Remaining new, learning and review cards">
      <span class={`c-new ${queue === 'new' ? 'cur' : ''}`}>{counts.new}</span>
      <span class={`c-learn ${queue === 'learn' ? 'cur' : ''}`}>{counts.learn}</span>
      <span class={`c-review ${queue === 'review' ? 'cur' : ''}`}>{counts.review}</span>
    </div>
  );

  const swipeAction = swipe ? col.settings.swipe[swipe.dir] : 'none';
  const swipeColor: Record<string, string> = { again: 'var(--again)', hard: 'var(--hard)', good: 'var(--good)', easy: 'var(--easy)' };

  return (
    <div class="study">
      <header class="navbar">
        <div class="left">
          <button class="text-btn" onClick={() => navigate('', true)}>
            Done
          </button>
        </div>
        <h1>{col.settings.showRemaining ? countEl : deck?.name.split('::').pop()}</h1>
        <div class="right">
          <button class="icon-btn" onClick={undo} disabled={!col.undoLabel} aria-label="Undo" title="Undo (u)">
            <Icon name="undo" />
          </button>
          <button class="icon-btn" onClick={menu} aria-label="More actions">
            <Icon name="more" />
          </button>
        </div>
      </header>

      {card && rendered && nt ? (
        <>
          <div
            class="card-area"
            ref={areaRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              touch.current = null;
              setSwipe(null);
            }}
          >
            {card.flag > 0 && <div class="flag-strip" style={{ background: FLAG_COLORS[card.flag] }} />}
            {col.hasTag(card.noteId, 'marked') && <div class="mark-star">★</div>}
            <CardView
              html={showAnswer ? rendered.answer : rendered.question}
              css={nt.css}
              className={`card${card.ord + 1}`}
              autoplay
            />
            {swipe && swipeAction !== 'none' && (
              <div
                class="swipe-hint"
                style={{
                  opacity: swipe.strength,
                  background: swipeColor[swipeAction] ?? 'var(--accent)',
                  [swipe.dir === 'right' ? 'left' : 'right']: '16px',
                }}
              >
                {showAnswer || !['again', 'hard', 'good', 'easy'].includes(swipeAction) ? labelFor(swipeAction) : 'Show answer'}
              </div>
            )}
          </div>
          <div class="answer-bar">
            <div class="inner">
              {!showAnswer ? (
                <button class="btn primary show-btn" onClick={() => setShowAnswer(true)}>
                  Show Answer
                </button>
              ) : previews === null ? (
                // Preview (non-rescheduling filtered deck)
                ([1, 3] as Rating[]).map((r) => (
                  <button class={`rate-btn ${RATING_CLASS[r]}`} onClick={() => answer(r)}>
                    {r === 1 ? 'Again' : 'Next'}
                    <small>{r === 1 ? '1m' : 'done'}</small>
                  </button>
                ))
              ) : (
                ([1, 2, 3, 4] as Rating[]).map((r) => (
                  <button class={`rate-btn ${RATING_CLASS[r]}`} onClick={() => answer(r)} title={`${RATING_NAMES[r]} (${r})`}>
                    {col.settings.showIntervals && <small>{formatInterval(previews[r].secs)}</small>}
                    {RATING_NAMES[r]}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      ) : (
        <Finished deckId={deckId} next={next} session={session} onResume={advance} />
      )}

      {overlay?.kind === 'edit' && (
        <div class="backdrop" style="align-items:stretch">
          <div class="sheet" style="max-width:860px;max-height:100dvh;border-radius:0;height:100dvh">
            <NoteEditor
              noteId={overlay.card.noteId}
              onDone={() => {
                setOverlay(null);
              }}
            />
          </div>
        </div>
      )}
      {overlay?.kind === 'info' && (
        <div class="backdrop" style="align-items:stretch">
          <div class="sheet" style="max-width:860px;max-height:100dvh;border-radius:0;height:100dvh">
            <CardInfo cardId={overlay.card.id} onClose={() => setOverlay(null)} />
          </div>
        </div>
      )}
    </div>
  );
}

function labelFor(a: GestureAction): string {
  const map: Partial<Record<GestureAction, string>> = {
    again: 'Again',
    hard: 'Hard',
    good: 'Good',
    easy: 'Easy',
    showAnswer: 'Show answer',
    undo: 'Undo',
    bury: 'Bury',
    suspend: 'Suspend',
    mark: 'Mark',
    flag: 'Flag',
    edit: 'Edit',
    info: 'Info',
    replay: 'Replay',
  };
  return map[a] ?? '';
}

function Finished(props: { deckId: number; next: NextCard; session: StudySession; onResume: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (props.next.kind !== 'wait') return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [props.next]);
  const deck = col.decks.get(props.deckId);
  const buried = [...col.cards.values()].some(
    (c) => c.buried && col.deckAndChildren(props.deckId).some((d) => d.id === c.deckId),
  );
  if (props.next.kind === 'wait') {
    const secs = Math.max(0, Math.round((props.next.until - Date.now()) / 1000));
    return (
      <div class="study-done">
        <h2>Learning cards coming up</h2>
        <p class="muted">The next learning card is due in {formatInterval(secs)}.</p>
        <button class="btn primary" onClick={props.onResume}>
          Check again
        </button>
      </div>
    );
  }
  const anyNew = [...col.cards.values()].some(
    (c) => c.state === CardState.New && !c.suspended && col.deckAndChildren(props.deckId).some((d) => d.id === c.deckId),
  );
  return (
    <div class="study-done">
      <div style="font-size:44px">🎉</div>
      <h2>Congratulations!</h2>
      <p class="muted" style="max-width:420px;line-height:1.5">
        {props.session.answered
          ? `You studied ${props.session.answered} card${props.session.answered === 1 ? '' : 's'} in ${formatInterval(
              Math.max(1, (Date.now() - props.session.startedAt) / 1000),
            )}. `
          : ''}
        You have finished {deck?.name.split('::').pop() ?? 'this deck'} for now.
        {anyNew && !deck?.dyn ? ' The new card limit was reached; you can study more with Custom Study.' : ''}
      </p>
      <div class="row-actions" style="justify-content:center">
        {deck?.dyn ? (
          <button
            class="btn"
            onClick={() => {
              col.rebuildFiltered(props.deckId);
              props.onResume();
            }}
          >
            Rebuild
          </button>
        ) : (
          <button class="btn" onClick={() => navigate(`custom-study/${props.deckId}`)}>
            Custom Study
          </button>
        )}
        {buried && (
          <button
            class="btn"
            onClick={() => {
              col.unburyDeck(props.deckId);
              props.onResume();
            }}
          >
            Unbury
          </button>
        )}
        <button class="btn primary" onClick={() => navigate('', true)}>
          Back to Decks
        </button>
      </div>
    </div>
  );
}
