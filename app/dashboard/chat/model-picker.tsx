'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { FAMILIES, FAMILY_LABELS, type Family } from '@/lib/ai/source-types';

const AUTO = 'auto';

const compact = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Every search term must start a word of the name or family ("op" finds opus,
 * not anthropic), or, from three characters, appear in the name with its
 * punctuation dropped ("gpt5" finds gpt-5-mini). Groups keep the routing family order.
 */
export function arrange(models: string[], families: Record<string, Family>, query: string) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const byFamily = new Map<Family, string[]>();
  for (const model of models) {
    const family = families[model] ?? 'other';
    const words = (model + ' ' + family + ' ' + FAMILY_LABELS[family]).toLowerCase().split(/[^a-z0-9.]+/);
    const matches = (term: string) => words.some((word) => word.startsWith(term))
      || (compact(term).length >= 3 && compact(model).includes(compact(term)));
    if (terms.every(matches)) byFamily.set(family, [...(byFamily.get(family) ?? []), model]);
  }
  const groups = FAMILIES.flatMap((family) => {
    const members = byFamily.get(family);
    return members ? [{ family, models: members }] : [];
  });
  const showAuto = terms.every((term) => 'auto automatic'.includes(term));
  return { groups, flat: [...(showAuto ? [AUTO] : []), ...groups.flatMap((group) => group.models)] };
}

/**
 * The composer's model choice: a searchable list grouped by model family.
 *
 * A native select stops scaling once a plan can reach dozens of models across
 * vendors. Groups follow the routing family order so related models sit
 * together, and every search term must match the name or the family label, so
 * "claude opus" or "google flash" both narrow the list the way people expect.
 */
export function ModelPicker({ value, models, families, autoHint, disabled, onChange }: {
  value: string;
  models: string[];
  families: Record<string, Family>;
  /** The model Auto would currently pick, shown so Auto is not a mystery. */
  autoHint: string;
  disabled?: boolean;
  onChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();

  const { groups, flat } = useMemo(() => arrange(models, families, query), [models, families, query]);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (open) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  function show(): void {
    setQuery('');
    setActive(Math.max(0, arrange(models, families, '').flat.indexOf(value)));
    setOpen(true);
  }

  function choose(model: string | undefined): void {
    if (model === undefined) return;
    onChange(model);
    setOpen(false);
    button.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    const last = flat.length - 1;
    if (event.key === 'ArrowDown') setActive((index) => Math.min(last, index + 1));
    else if (event.key === 'ArrowUp') setActive((index) => Math.max(0, index - 1));
    else if (event.key === 'Home') setActive(0);
    else if (event.key === 'End') setActive(Math.max(0, last));
    else if (event.key === 'Enter') choose(flat[active]);
    else if (event.key === 'Escape') { setOpen(false); button.current?.focus(); }
    else if (event.key === 'Tab') { setOpen(false); return; }
    else return;
    // Enter must not submit the composer, and arrows must not move the caret.
    event.preventDefault();
    event.stopPropagation();
  }

  const optionId = (model: string) => id + '-' + flat.indexOf(model);

  return (
    <div ref={root} className="relative min-w-0 max-w-full">
      <button
        ref={button}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={'Model: ' + (value === AUTO ? 'Auto' : value)}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(event) => { if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) { event.preventDefault(); show(); } }}
        className="flex max-w-full items-center gap-1.5 rounded-lg px-2 py-2 text-xs text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50 disabled:hover:bg-transparent sm:max-w-56"
      >
        <span className="truncate">{value === AUTO ? 'Auto model' : value}</span>
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-72 max-w-[calc(100vw-4rem)] sm:w-80 rounded-xl border border-zinc-200 bg-white p-2 shadow-lg">
          <input
            ref={search}
            type="search"
            role="combobox"
            aria-label="Search models"
            aria-expanded="true"
            aria-controls={id + '-list'}
            aria-autocomplete="list"
            aria-activedescendant={flat[active] === undefined ? undefined : optionId(flat[active]!)}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            placeholder="Search models or families…"
            className="mb-2 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-900 outline-none placeholder:text-zinc-500 focus:border-zinc-400"
          />
          <ul ref={list} id={id + '-list'} role="listbox" aria-label="Models" className="max-h-64 space-y-0.5 overflow-y-auto">
            {flat[0] === AUTO && <PickerOption id={optionId(AUTO)} selected={value === AUTO} active={active === 0} onHover={() => setActive(0)} onSelect={() => choose(AUTO)}><span className="min-w-0"><span className="font-medium">Auto</span><span className="block truncate text-[11px] text-zinc-500">{autoHint ? 'Currently picks ' + autoHint : 'Picks a model for each prompt'}</span></span></PickerOption>}
            {groups.map((group) => (
              <li key={group.family} role="presentation">
                <p id={id + '-' + group.family} className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-widest text-zinc-500 uppercase">
                  {FAMILY_LABELS[group.family]} <span className="font-normal">· {group.models.length}</span>
                </p>
                <ul role="group" aria-labelledby={id + '-' + group.family} className="space-y-0.5">
                  {group.models.map((model) => <PickerOption key={model} id={optionId(model)} selected={value === model} active={flat.indexOf(model) === active} onHover={() => setActive(flat.indexOf(model))} onSelect={() => choose(model)}><span className="truncate" title={model}>{model}</span></PickerOption>)}
                </ul>
              </li>
            ))}
            {!flat.length && <li role="presentation" className="px-2.5 py-6 text-center text-xs text-zinc-500">No models match “{query.trim()}”.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function PickerOption({ id, selected, active, onHover, onSelect, children }: {
  id: string; selected: boolean; active: boolean; onHover: () => void; onSelect: () => void; children: React.ReactNode;
}) {
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      data-active={active}
      onPointerMove={() => { if (!active) onHover(); }}
      onClick={onSelect}
      className={'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-xs ' + (active ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-700')}
    >
      <span aria-hidden="true" className={'w-3 shrink-0 text-zinc-900 ' + (selected ? '' : 'invisible')}>✓</span>
      {children}
    </li>
  );
}
