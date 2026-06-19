import ChatRoom from './components/ChatRoom';

export default function Home() {
  return (
    <div className="flex flex-1 items-stretch justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 max-w-2xl flex-col bg-white shadow-sm dark:bg-zinc-950">
        <ChatRoom />
      </main>
    </div>
  );
}
