import { useCallback, useEffect, useState } from 'react';
import { Box, Text, render, useApp } from 'ink';
import Spinner from 'ink-spinner';
import Home from './home';
import Wizard, { type WizardResult } from './wizard';
import {
  buildProfileViews,
  claimProfileDefault,
  loadTuiState,
  removeProfileEnv,
  removeProfileSilent,
  setProfileArgsArray,
  setProfileEnv,
  type ProfileView,
  type TuiState,
} from './actions';

type TuiResult =
  | { action: 'run'; profile: string }
  | { action: 'install'; wizard: WizardResult }
  | { action: 'exit' };

type Screen =
  | { kind: 'loading' }
  | { kind: 'home' }
  | { kind: 'wizard' }
  | { kind: 'busy'; message: string }
  | { kind: 'error'; message: string };

function App({ onResolve }: { onResolve: (result: TuiResult) => void }) {
  const { exit } = useApp();
  const [state, setState] = useState<TuiState | null>(null);
  const [views, setViews] = useState<ProfileView[]>([]);
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });

  const reload = useCallback(async () => {
    try {
      const next = await loadTuiState();
      setState(next);
      setViews(buildProfileViews(next));
      setScreen((prev) => {
        if (prev.kind === 'loading') {
          return Object.keys(next.profiles).length === 0
            ? { kind: 'wizard' }
            : { kind: 'home' };
        }
        return prev;
      });
    } catch (err) {
      setScreen({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const finish = useCallback(
    (result: TuiResult) => {
      onResolve(result);
      exit();
    },
    [exit, onResolve],
  );

  if (screen.kind === 'loading' || !state) {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text> Loading profiles…</Text>
      </Box>
    );
  }

  if (screen.kind === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="red">Error: {screen.message}</Text>
        <Text dimColor>Press Ctrl+C to exit.</Text>
      </Box>
    );
  }

  if (screen.kind === 'busy') {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text> {screen.message}</Text>
      </Box>
    );
  }

  if (screen.kind === 'wizard') {
    const existing = Object.keys(state.profiles);
    return (
      <Wizard
        existingProfiles={existing}
        onSubmit={(wizard) => finish({ action: 'install', wizard })}
        onCancel={() => {
          if (existing.length === 0) {
            finish({ action: 'exit' });
          } else {
            setScreen({ kind: 'home' });
          }
        }}
      />
    );
  }

  return (
    <Home
      state={state}
      views={views}
      onRun={(profile) => finish({ action: 'run', profile })}
      onCreate={() => setScreen({ kind: 'wizard' })}
      onEdit={async (profile, scope, change) => {
        if (change.kind === 'args') {
          await setProfileArgsArray(profile, scope, change.tokens);
        } else if (change.kind === 'env') {
          await setProfileEnv(profile, scope, change.kv, change.replaceKey);
        } else if (change.kind === 'envRemove') {
          await removeProfileEnv(profile, scope, change.key);
        } else {
          await claimProfileDefault(profile, scope, change.name);
        }
        await reload();
      }}
      onRemoveRequest={async (profile) => {
        setScreen({ kind: 'busy', message: `Removing "${profile}"…` });
        try {
          await removeProfileSilent(profile);
          await reload();
          setScreen({ kind: 'home' });
        } catch (err) {
          setScreen({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }}
      onQuit={() => finish({ action: 'exit' })}
    />
  );
}

export async function runTuiApp(): Promise<TuiResult> {
  let result: TuiResult = { action: 'exit' };
  const { waitUntilExit } = render(
    <App
      onResolve={(r) => {
        result = r;
      }}
    />,
    { exitOnCtrlC: true },
  );
  try {
    await waitUntilExit();
  } catch {
    // waitUntilExit throws on Ctrl+C when exitOnCtrlC is true; treat as exit.
  }
  return result;
}
