import { col, navigate, toast, useCol } from './state';
import { NavBar, Row, actionSheet, confirm, prompt } from './components';
import type { Notetype } from '../core/types';

export function TagsScreen() {
  useCol();
  const tags = col.allTags();
  return (
    <div class="screen">
      <NavBar title={`Tags (${tags.size})`} backTo="settings" />
      <div class="content">
        {tags.size === 0 && <div class="empty-state">No tags yet.</div>}
        <div class="group">
          {[...tags].map(([tag, count]) => (
            <Row
              value={count}
              onClick={() =>
                void actionSheet(tag, [
                  { label: 'Browse notes', run: () => navigate(`browse?q=${encodeURIComponent(`tag:${tag}`)}`) },
                  {
                    label: 'Rename',
                    run: async () => {
                      const n = await prompt('Rename tag', tag, { message: 'Child tags (tag::child) are renamed too.', ok: 'Rename' });
                      if (n && n !== tag) col.renameTag(tag, n);
                    },
                  },
                  {
                    label: 'Remove from all notes',
                    destructive: true,
                    run: async () => {
                      if (await confirm(`Remove “${tag}”?`, `It will be removed from ${count} note(s).`, 'Remove', true)) {
                        col.deleteTag(tag);
                        toast('Tag removed', { label: 'Undo', run: () => col.undo() });
                      }
                    },
                  },
                ])
              }
            >
              {tag}
            </Row>
          ))}
        </div>
      </div>
    </div>
  );
}

export function NotetypesScreen() {
  useCol();
  const counts = new Map<number, number>();
  for (const n of col.notes.values()) counts.set(n.notetypeId, (counts.get(n.notetypeId) ?? 0) + 1);
  return (
    <div class="screen">
      <NavBar title="Note Types" backTo="settings" />
      <div class="content">
        <div class="group">
          {[...col.notetypes.values()].map((nt) => (
            <Row href={`#/notetype/${nt.id}`} sub={`${nt.fields.join(', ')} · ${counts.get(nt.id) ?? 0} notes`} chevron>
              {nt.name}
            </Row>
          ))}
        </div>
      </div>
    </div>
  );
}

export function NotetypeEditor({ id }: { id: number }) {
  useCol();
  const nt = col.notetypes.get(id);
  if (!nt) return <div class="empty-state">Note type not found.</div>;
  const save = (patch: Partial<Notetype>) => col.saveNotetype({ ...nt, ...patch });
  const inUse = [...col.notes.values()].some((n) => n.notetypeId === id);
  return (
    <div class="screen">
      <NavBar title={nt.name} backTo="notetypes" />
      <div class="content">
        <div class="group-title">Fields</div>
        <div class="group">
          {nt.fields.map((f, i) => (
            <Row
              onClick={async () => {
                const name = await prompt('Rename field', f, {
                  message: 'Templates referring to the field are updated.',
                  ok: 'Rename',
                });
                if (!name || name === f) return;
                if (nt.fields.includes(name)) return toast('A field with that name exists');
                const re = new RegExp(`\\{\\{([#^/]?)([^}]*:)?${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'g');
                const fix = (t: string) => t.replace(re, (_m, pre: string, filt?: string) => `{{${pre}${filt ?? ''}${name}}}`);
                save({
                  fields: nt.fields.map((x, j) => (j === i ? name : x)),
                  templates: nt.templates.map((t) => ({ ...t, qfmt: fix(t.qfmt), afmt: fix(t.afmt) })),
                });
              }}
              value={i === nt.sortField ? 'sort field' : undefined}
            >
              {f}
            </Row>
          ))}
          <Row
            onClick={async () => {
              const name = await prompt('Add field', '', { ok: 'Add' });
              if (!name?.trim() || nt.fields.includes(name)) return;
              col.transact('Add field', () => {
                save({ fields: [...nt.fields, name.trim()] });
                for (const n of col.notes.values()) if (n.notetypeId === id) col.updateNote({ ...n, fields: [...n.fields, ''] });
              });
            }}
          >
            <span style="color:var(--accent)">Add field</span>
          </Row>
        </div>
        {nt.templates.map((t, i) => (
          <>
            <div class="group-title">{nt.kind === 'cloze' ? 'Cloze template' : t.name}</div>
            <label class="field">
              <span>Front template</span>
              <textarea
                style="font-family:ui-monospace,monospace;font-size:13px"
                value={t.qfmt}
                onChange={(e) => save({ templates: nt.templates.map((x, j) => (j === i ? { ...x, qfmt: (e.target as HTMLTextAreaElement).value } : x)) })}
              />
            </label>
            <label class="field">
              <span>Back template</span>
              <textarea
                style="font-family:ui-monospace,monospace;font-size:13px"
                value={t.afmt}
                onChange={(e) => save({ templates: nt.templates.map((x, j) => (j === i ? { ...x, afmt: (e.target as HTMLTextAreaElement).value } : x)) })}
              />
            </label>
          </>
        ))}
        <label class="field">
          <span>Styling (CSS)</span>
          <textarea
            style="font-family:ui-monospace,monospace;font-size:13px;min-height:160px"
            value={nt.css}
            onChange={(e) => save({ css: (e.target as HTMLTextAreaElement).value })}
          />
        </label>
        <div class="group">
          <Row
            onClick={async () => {
              const name = await prompt('Rename note type', nt.name, { ok: 'Rename' });
              if (name) save({ name });
            }}
          >
            Rename
          </Row>
          {nt.kind === 'standard' && (
            <Row
              onClick={async () => {
                const name = await prompt('New card type name', `Card ${nt.templates.length + 1}`, { ok: 'Add' });
                if (!name) return;
                col.transact('Add card type', () => {
                  save({ templates: [...nt.templates, { name, qfmt: `{{${nt.fields[1] ?? nt.fields[0]}}}`, afmt: `{{FrontSide}}\n\n<hr id=answer>\n\n{{${nt.fields[0]}}}` }] });
                  for (const n of col.notes.values()) if (n.notetypeId === id) col.updateNote(n);
                });
              }}
            >
              Add card type
            </Row>
          )}
          <Row
            onClick={() => {
              const copy = { ...structuredClone(nt), id: col.newId(), name: `${nt.name} copy` };
              col.transact('Clone note type', () => col.putNotetype(copy));
              navigate(`notetype/${copy.id}`);
            }}
          >
            Clone
          </Row>
        </div>
        {inUse && <p class="hint-text">Template changes apply to all notes of this type. Removing fields is not supported.</p>}
      </div>
    </div>
  );
}
