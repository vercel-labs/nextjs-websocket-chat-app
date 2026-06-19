'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Avatar from 'boring-avatars';
import Chat from './Chat';

const ID_KEY = 'chat:clientId';
const NAME_KEY = 'chat:name';

const ADJECTIVES = ['Swift', 'Calm', 'Brave', 'Lucky', 'Clever', 'Sunny', 'Quiet', 'Bold'];
const ANIMALS = ['Otter', 'Falcon', 'Fox', 'Panda', 'Heron', 'Lynx', 'Whale', 'Moth'];

function randomName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${adj} ${animal}`;
}

export default function ChatRoom() {
  const [clientId, setClientId] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Gate rendering until we've read sessionStorage so SSR and the first client
  // render agree (no hydration mismatch) and we don't flash the join form.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      // Per-tab identity, generated with the Web Crypto API and stored in
      // sessionStorage: it survives reloads of this tab (so messages stay
      // attributed to you) but is NOT shared with other tabs — each tab is a
      // distinct user with its own avatar. localStorage would leak one
      // identity across every tab in the browser.
      let id = sessionStorage.getItem(ID_KEY);
      if (!id) {
        id = crypto.randomUUID();
        sessionStorage.setItem(ID_KEY, id);
      }
      setClientId(id);
      setName(sessionStorage.getItem(NAME_KEY));
      setDraft(randomName());
      setReady(true);
    });
  }, []);

  if (!ready || !clientId) return null;

  if (name) {
    return (
      <Chat
        clientId={clientId}
        name={name}
        onLeave={() => {
          sessionStorage.removeItem(NAME_KEY);
          setName(null);
          setDraft(randomName());
        }}
      />
    );
  }

  const join = (event: FormEvent) => {
    event.preventDefault();
    const chosen = draft.trim().slice(0, 40);
    if (!chosen) return;
    sessionStorage.setItem(NAME_KEY, chosen);
    setName(chosen);
  };

  return (
    <form
      onSubmit={join}
      className="mx-auto flex flex-1 w-full max-w-sm flex-col items-center justify-center gap-5 px-6"
    >
      <Avatar size={64} name={clientId} variant="beam" />
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Join the chat</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Pick a display name to enter the room.
        </p>
      </div>
      <input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Your name"
        className="w-full rounded-full border border-black/10 bg-transparent px-4 py-2 text-center text-sm outline-none focus:border-blue-500 dark:border-white/15"
        aria-label="Your name"
      />
      <button
        type="submit"
        disabled={!draft.trim()}
        className="rounded-full bg-blue-600 px-6 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        Enter
      </button>
    </form>
  );
}
