import os from 'node:os';
import { type ReactNode, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import type { EditScope, ProfileView, ScopeView, TuiState } from './actions';

type EditChange =
  | { kind: 'args'; tokens: string[] }
  | { kind: 'env'; kv: string; replaceKey?: string }
  | { kind: 'envRemove'; key: string }
  | { kind: 'defaultClaim'; name: string };

interface HomeProps {
  state: TuiState;
  views: ProfileView[];
  onRun: (profile: string) => void;
  onCreate: () => void;
  onEdit: (
    profile: string,
    scope: EditScope,
    change: EditChange,
  ) => Promise<void>;
  onRemoveRequest: (profile: string) => Promise<void>;
  onQuit: () => void;
}

type Modal =
  | { kind: 'none' }
  | { kind: 'detail'; profile: string }
  | { kind: 'editScope'; profile: string }
  | { kind: 'editForm'; profile: string; scope: EditScope }
  | { kind: 'confirmRemove'; profile: string };

export default function Home(props: HomeProps) {
  const { state, views, onRun, onCreate, onEdit, onRemoveRequest, onQuit } =
    props;

  // cursor 0..N-1 = views, cursor N = [+ Create]
  const [cursor, setCursor] = useState<number>(0);
  const [modal, setModal] = useState<Modal>({ kind: 'none' });
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), 2500);
    return () => clearTimeout(timer);
  }, [status]);

  const totalRows = 1 + views.length;
  const createIdx = views.length;
  const highlightedView = cursor < views.length ? views[cursor] : null;

  useInput((input, key) => {
    if (modal.kind !== 'none') return;
    if (input === 'q' || key.escape) {
      onQuit();
      return;
    }
    if (key.upArrow || input === 'k') {
      setCursor((c) => (c - 1 + totalRows) % totalRows);
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor((c) => (c + 1) % totalRows);
      return;
    }
    if (key.return) {
      if (cursor === createIdx) onCreate();
      else if (highlightedView) onRun(highlightedView.profile);
      return;
    }
    if (input === 'n') {
      onCreate();
      return;
    }
    if (input >= '1' && input <= '9') {
      const idx = Number(input) - 1;
      if (idx < views.length) {
        onRun(views[idx].profile);
      }
      return;
    }
    if (!highlightedView) return;
    if (input === 'd') {
      setModal({ kind: 'detail', profile: highlightedView.profile });
      return;
    }
    if (input === 'e') {
      setModal({ kind: 'editScope', profile: highlightedView.profile });
      return;
    }
    if (input === 'x') {
      setModal({ kind: 'confirmRemove', profile: highlightedView.profile });
    }
  });

  if (modal.kind === 'detail') {
    const target = views.find((v) => v.profile === modal.profile);
    if (!target) {
      setModal({ kind: 'none' });
      return null;
    }
    return (
      <Detail
        view={target}
        projectConfigPath={state.projectConfig.path}
        globalConfigPath={state.globalConfig.path}
        onRun={() => {
          setModal({ kind: 'none' });
          onRun(target.profile);
        }}
        onEdit={() => setModal({ kind: 'editScope', profile: target.profile })}
        onBack={() => setModal({ kind: 'none' })}
      />
    );
  }

  if (modal.kind === 'editScope') {
    const target = views.find((v) => v.profile === modal.profile);
    if (!target) {
      setModal({ kind: 'none' });
      return null;
    }
    return (
      <EditScopePicker
        profile={target.profile}
        hasProjectConfig={Boolean(state.projectConfig.path)}
        projectPath={state.projectConfig.path}
        onPick={(scope) =>
          setModal({ kind: 'editForm', profile: target.profile, scope })
        }
        onCancel={() => setModal({ kind: 'none' })}
      />
    );
  }

  if (modal.kind === 'editForm') {
    const target = views.find((v) => v.profile === modal.profile);
    if (!target) {
      setModal({ kind: 'none' });
      return null;
    }
    const scopeView = modal.scope === 'global' ? target.global : target.project;
    const scopeConfig =
      modal.scope === 'global' ? state.globalConfig : state.projectConfig;
    const agent = target.record.name;
    const defaultHolders = {
      default: scopeConfig.defaultProfile,
      agent: scopeConfig.agentDefaults?.[agent] ?? null,
    };
    const showShadow = modal.scope === 'global';
    const shadowFlags = {
      args: showShadow && Boolean(target.project.hasArgs),
      env: showShadow && target.project.envKeys.length > 0,
      overallDefault: showShadow && state.projectConfig.defaultProfile !== null,
      agentDefault:
        showShadow && state.projectConfig.agentDefaults?.[agent] !== undefined,
    };
    return (
      <EditForm
        profile={target.profile}
        agent={agent}
        scope={modal.scope}
        scopeView={scopeView}
        defaultHolders={defaultHolders}
        shadowFlags={shadowFlags}
        projectConfigPath={state.projectConfig.path}
        hasProjectConfig={Boolean(state.projectConfig.path)}
        onApply={(change) => onEdit(target.profile, modal.scope, change)}
        onBack={() => setModal({ kind: 'none' })}
      />
    );
  }

  if (modal.kind === 'confirmRemove') {
    return (
      <RemoveConfirm
        profile={modal.profile}
        onConfirm={async () => {
          const profile = modal.profile;
          setModal({ kind: 'none' });
          await onRemoveRequest(profile);
          setStatus(`Removed "${profile}".`);
        }}
        onCancel={() => setModal({ kind: 'none' })}
      />
    );
  }

  const anyOverride = views.some((v) => v.hasProjectEntry);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          agenv
        </Text>
        <Text dimColor> — Agent Environment Manager</Text>
      </Box>

      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <HeaderRow />
        {views.map((view, idx) => {
          const isActive = cursor === idx;
          return (
            <ProfileRow
              key={view.profile}
              view={view}
              active={isActive}
              index={idx}
            />
          );
        })}
        {views.length === 0 && (
          <Box>
            <Text dimColor>No profiles installed.</Text>
          </Box>
        )}
        <CreateRow active={cursor === createIdx} />
      </Box>

      {anyOverride && state.projectConfig.path && (
        <Box>
          <Text dimColor>
            † Project config at {state.projectConfig.path} overrides here —
            press d for detail
          </Text>
        </Box>
      )}

      <Box>
        {status ? (
          <Text color="yellow">{status}</Text>
        ) : (
          <Text dimColor>
            1-9 run; n new; e edit; x remove; d detail; q quit
          </Text>
        )}
      </Box>
    </Box>
  );
}

const COL_NAME = 16;
const COL_AGENT = 18;
const COL_ARGS = 16;
const COL_ENV = 20;

function HeaderRow() {
  return (
    <Box>
      <Text>{'    '}</Text>
      <Box width={COL_NAME}>
        <Text dimColor>Name</Text>
      </Box>
      <Box width={COL_AGENT}>
        <Text dimColor>Agent</Text>
      </Box>
      <Box width={COL_ARGS}>
        <Text dimColor>Args</Text>
      </Box>
      <Box width={COL_ENV}>
        <Text dimColor>Env</Text>
      </Box>
      <Text dimColor>Default</Text>
    </Box>
  );
}

function CreateRow({ active }: { active: boolean }) {
  return (
    <Box>
      <Text>{'  '}</Text>
      <Text color={active ? 'cyan' : undefined}>{active ? '> ' : '  '}</Text>
      <Text color={active ? 'cyan' : 'green'} bold={active}>
        + Create new profile
      </Text>
    </Box>
  );
}

function ProfileRow({
  view,
  active,
  index,
}: {
  view: ProfileView;
  active: boolean;
  index: number;
}) {
  const color = active ? 'cyan' : undefined;
  const numberLabel = index < 9 ? `${index + 1} ` : '  ';
  const nameLabel = `${view.profile}${view.hasProjectEntry ? ' †' : ''}`;
  return (
    <Box>
      <Text dimColor>{numberLabel}</Text>
      <Text color={color}>{active ? '> ' : '  '}</Text>
      <Box width={COL_NAME}>
        <Text color={color} bold={active}>
          {nameLabel}
        </Text>
      </Box>
      <Box width={COL_AGENT}>
        <Text dimColor={!active}>
          {view.record.name}@{view.record.version}
        </Text>
      </Box>
      <Box width={COL_ARGS}>
        <Text dimColor={!active}>{formatArgs(view.effective)}</Text>
      </Box>
      <Box width={COL_ENV}>
        <Text dimColor={!active}>{formatEnv(view.effective)}</Text>
      </Box>
      <Text dimColor={!active}>{formatDefaults(view.defaults)}</Text>
    </Box>
  );
}

function formatArgs(scope: { hasArgs: boolean; args: string }): string {
  if (!scope.hasArgs) return '—';
  const v = scope.args || '(empty)';
  return truncate(v, COL_ARGS - 1);
}

function formatEnv(scope: { envKeys: string[] }): string {
  if (scope.envKeys.length === 0) return '—';
  const shown = scope.envKeys.slice(0, 2).join(',');
  const suffix = scope.envKeys.length > 2 ? `+${scope.envKeys.length - 2}` : '';
  return `${truncate(shown, COL_ENV - suffix.length - 1)}${suffix}`;
}

function formatDefaults(defaults: string[]): string {
  if (defaults.length === 0) return '';
  return defaults.join(', ');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function Detail({
  view,
  projectConfigPath,
  globalConfigPath,
  onRun,
  onEdit,
  onBack,
}: {
  view: ProfileView;
  projectConfigPath: string | null;
  globalConfigPath: string | null;
  onRun: () => void;
  onEdit: () => void;
  onBack: () => void;
}) {
  useInput((input, key) => {
    if (key.escape) onBack();
    else if (key.return) onRun();
    else if (input === 'e') onEdit();
  });
  const tags: string[] = [`${view.record.name}@${view.record.version}`];
  if (view.record.pinned) tags.push('pinned');
  const projectKeySet = new Set(view.project.envKeys);
  const projectArgsActive = view.project.hasArgs;
  const globalArgsActive = !view.project.hasArgs && view.global.hasArgs;
  const globalArgsShadowed = view.project.hasArgs && view.global.hasArgs;
  const projectPathLabel = projectConfigPath
    ? (homify(projectConfigPath) ?? projectConfigPath)
    : '(none here)';
  const globalPathLabel = globalConfigPath
    ? (homify(globalConfigPath) ?? globalConfigPath)
    : '~/.agenv/.agenv.json';
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box>
        <Text bold color="cyan">
          {view.profile}
        </Text>
        <Text dimColor> ({tags.join(', ')})</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <PivotRow
          label=""
          projectCell={<Text color="blue">project</Text>}
          globalCell={<Text color="blue">global</Text>}
        />
        <PivotRow
          label=""
          projectCell={<Text dimColor>{projectPathLabel}</Text>}
          globalCell={<Text dimColor>{globalPathLabel}</Text>}
        />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <PivotRow
          label="args:"
          projectCell={
            <ArgsCell scope={view.project} active={projectArgsActive} />
          }
          globalCell={
            <ArgsCell
              scope={view.global}
              active={globalArgsActive}
              shadowed={globalArgsShadowed}
            />
          }
        />
        <PivotRow
          label="env:"
          projectCell={
            <EnvCell scope={view.project} shadowedKeys={new Set()} />
          }
          globalCell={
            <EnvCell
              scope={view.global}
              shadowedKeys={
                new Set(view.global.envKeys.filter((k) => projectKeySet.has(k)))
              }
            />
          }
        />
        <PivotRow
          label="defaults:"
          projectCell={
            <DefaultsCell
              defaults={view.projectDefaults}
              shadowedDefaults={[]}
            />
          }
          globalCell={
            <DefaultsCell
              defaults={view.globalDefaults}
              shadowedDefaults={view.shadowedDefaults}
            />
          }
        />
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Project config overrides global when both are set.</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>↵ run e edit esc back</Text>
      </Box>
    </Box>
  );
}

const PIVOT_LABEL_W = 12;
const PIVOT_PROJECT_W = 32;

function PivotRow({
  label,
  projectCell,
  globalCell,
}: {
  label: string;
  projectCell: ReactNode;
  globalCell: ReactNode;
}) {
  return (
    <Box>
      <Box width={PIVOT_LABEL_W}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box width={PIVOT_PROJECT_W}>{projectCell}</Box>
      <Box>{globalCell}</Box>
    </Box>
  );
}

function ArgsCell({
  scope,
  active,
  shadowed,
}: {
  scope: ScopeView;
  active: boolean;
  shadowed?: boolean;
}) {
  if (!scope.hasArgs) return <Text dimColor>—</Text>;
  const text = scope.args || '(empty)';
  if (active) return <Text bold>{text}</Text>;
  if (shadowed)
    return (
      <Text dimColor strikethrough>
        {text}
      </Text>
    );
  return <Text dimColor>{text}</Text>;
}

function EnvCell({
  scope,
  shadowedKeys,
}: {
  scope: ScopeView;
  shadowedKeys: Set<string>;
}) {
  if (scope.envKeys.length === 0) return <Text dimColor>—</Text>;
  return (
    <Text>
      {scope.envKeys.map((k, i) => {
        const isShadowed = shadowedKeys.has(k);
        const value = `${k}=${scope.env[k] ?? ''}`;
        return (
          <Text key={k}>
            {i > 0 && <Text dimColor>, </Text>}
            {isShadowed ? (
              <Text dimColor strikethrough>
                {value}
              </Text>
            ) : (
              <Text bold>{value}</Text>
            )}
          </Text>
        );
      })}
    </Text>
  );
}

function DefaultsCell({
  defaults,
  shadowedDefaults,
}: {
  defaults: string[];
  shadowedDefaults: string[];
}) {
  if (defaults.length === 0) return <Text dimColor>—</Text>;
  return (
    <Text>
      {defaults.map((name, i) => {
        const isShadowed = shadowedDefaults.includes(name);
        return (
          <Text key={name}>
            {i > 0 && <Text dimColor>, </Text>}
            {isShadowed ? (
              <Text dimColor strikethrough>
                {name}
              </Text>
            ) : (
              <Text bold>{name}</Text>
            )}
          </Text>
        );
      })}
    </Text>
  );
}

function homify(path: string | null): string | null {
  if (!path) return null;
  const home = os.homedir();
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  if (home && path === home) return '~';
  return path;
}

function EditScopePicker({
  profile,
  hasProjectConfig,
  projectPath,
  onPick,
  onCancel,
}: {
  profile: string;
  hasProjectConfig: boolean;
  projectPath: string | null;
  onPick: (scope: EditScope) => void;
  onCancel: () => void;
}) {
  const projectSuffix = hasProjectConfig
    ? ` (${projectPath})`
    : ' (creates ./.agenv.json)';
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        Edit <Text color="cyan">{profile}</Text> — pick scope
      </Text>
      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: `Edit project${projectSuffix}`, value: 'project' },
            { label: 'Edit global', value: 'global' },
            { label: 'Cancel', value: 'cancel' },
          ]}
          onSelect={(item) => {
            if (item.value === 'project') onPick('project');
            else if (item.value === 'global') onPick('global');
            else onCancel();
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Esc: cancel</Text>
      </Box>
    </Box>
  );
}

type Field =
  | { kind: 'argsToken'; index: number }
  | { kind: 'argsAdd' }
  | { kind: 'envToken'; key: string }
  | { kind: 'envAdd' }
  | { kind: 'defaultClaim' };

type EditingState = { fieldKey: string; value: string } | null;

function fieldKey(field: Field): string {
  switch (field.kind) {
    case 'argsToken':
      return `argsToken:${field.index}`;
    case 'argsAdd':
      return 'argsAdd';
    case 'envToken':
      return `envToken:${field.key}`;
    case 'envAdd':
      return 'envAdd';
    case 'defaultClaim':
      return 'defaultClaim';
  }
}

interface ShadowFlags {
  args: boolean;
  env: boolean;
  overallDefault: boolean;
  agentDefault: boolean;
}

interface DefaultHolding {
  name: string;
  shadowed: boolean;
}

interface ClaimableDefault {
  name: string;
  current: string | null;
}

function EditForm({
  profile,
  agent,
  scope,
  scopeView,
  defaultHolders,
  shadowFlags,
  projectConfigPath,
  hasProjectConfig,
  onApply,
  onBack,
}: {
  profile: string;
  agent: string;
  scope: EditScope;
  scopeView: ScopeView;
  defaultHolders: { default: string | null; agent: string | null };
  shadowFlags: ShadowFlags;
  projectConfigPath: string | null;
  hasProjectConfig: boolean;
  onApply: (change: EditChange) => Promise<void>;
  onBack: () => void;
}) {
  const anyShadow =
    shadowFlags.args ||
    shadowFlags.env ||
    shadowFlags.overallDefault ||
    shadowFlags.agentDefault;
  const argsTokens = scopeView.argsArray;
  const envKeys = scopeView.envKeys;

  const myDefaults: DefaultHolding[] = [];
  if (defaultHolders.default === profile) {
    myDefaults.push({ name: 'default', shadowed: shadowFlags.overallDefault });
  }
  if (defaultHolders.agent === profile) {
    myDefaults.push({ name: agent, shadowed: shadowFlags.agentDefault });
  }

  const claimable: ClaimableDefault[] = [];
  if (defaultHolders.default !== profile) {
    claimable.push({ name: 'default', current: defaultHolders.default });
  }
  if (defaultHolders.agent !== profile) {
    claimable.push({ name: agent, current: defaultHolders.agent });
  }

  const fields: Field[] = [
    ...argsTokens.map((_, i) => ({ kind: 'argsToken', index: i }) as Field),
    { kind: 'argsAdd' },
    ...envKeys.map((k) => ({ kind: 'envToken', key: k }) as Field),
    { kind: 'envAdd' },
    ...(claimable.length > 0 ? [{ kind: 'defaultClaim' } as Field] : []),
  ];
  const total = fields.length;
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<EditingState>(null);
  const [claimOpen, setClaimOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = fields[Math.min(cursor, total - 1)];

  useInput((input, key) => {
    if (editing || claimOpen) return;
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow || input === 'k') {
      setCursor((c) => (c - 1 + total) % total);
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor((c) => (c + 1) % total);
      return;
    }
    if (key.return) {
      const f = current;
      if (f.kind === 'argsToken') {
        setEditing({
          fieldKey: fieldKey(f),
          value: argsTokens[f.index] ?? '',
        });
      } else if (f.kind === 'argsAdd') {
        setEditing({ fieldKey: fieldKey(f), value: '' });
      } else if (f.kind === 'envToken') {
        const v = scopeView.env[f.key] ?? '';
        setEditing({ fieldKey: fieldKey(f), value: `${f.key}=${v}` });
      } else if (f.kind === 'envAdd') {
        setEditing({ fieldKey: fieldKey(f), value: '' });
      } else {
        setClaimOpen(true);
      }
      return;
    }
    if (input === 'x') {
      const f = current;
      if (f.kind === 'argsToken') {
        const next = argsTokens.filter((_, i) => i !== f.index);
        void (async () => {
          await onApply({ kind: 'args', tokens: next });
          setCursor((c) => Math.min(c, total - 2));
        })();
      } else if (f.kind === 'envToken') {
        const k = f.key;
        void (async () => {
          await onApply({ kind: 'envRemove', key: k });
          setCursor((c) => Math.min(c, total - 2));
        })();
      }
    }
  });

  const submitEdit = async (raw: string) => {
    if (!editing) return;
    setError(null);
    const f = current;
    try {
      if (f.kind === 'argsToken') {
        const trimmed = raw.trim();
        if (!trimmed) {
          // Empty submit deletes the token
          const next = argsTokens.filter((_, i) => i !== f.index);
          await onApply({ kind: 'args', tokens: next });
        } else {
          const next = argsTokens.slice();
          next[f.index] = trimmed;
          await onApply({ kind: 'args', tokens: next });
        }
      } else if (f.kind === 'argsAdd') {
        const trimmed = raw.trim();
        if (trimmed) {
          await onApply({ kind: 'args', tokens: [...argsTokens, trimmed] });
        }
      } else if (f.kind === 'envToken') {
        const trimmed = raw.trim();
        if (!trimmed) {
          await onApply({ kind: 'envRemove', key: f.key });
        } else {
          await onApply({ kind: 'env', kv: trimmed, replaceKey: f.key });
        }
      } else {
        const trimmed = raw.trim();
        if (trimmed) {
          await onApply({ kind: 'env', kv: trimmed });
        }
      }
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (claimOpen) {
    return (
      <ClaimDefaultMenu
        profile={profile}
        scope={scope}
        claimable={claimable}
        hasProjectConfig={hasProjectConfig}
        projectConfigPath={projectConfigPath}
        onPick={async (name) => {
          setClaimOpen(false);
          try {
            await onApply({ kind: 'defaultClaim', name });
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
        onCancel={() => setClaimOpen(false)}
      />
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box>
        <Text bold>
          Edit <Text color="cyan">{profile}</Text>
        </Text>
        <Text dimColor> ({scope} scope)</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <SectionHeader label="Args" shadowed={shadowFlags.args} />
        {argsTokens.map((token, idx) => {
          const f: Field = { kind: 'argsToken', index: idx };
          const flatIdx = idx;
          return (
            <FieldRow
              // biome-ignore lint/suspicious/noArrayIndexKey: args tokens are positional, no stable id
              key={`arg-${idx}`}
              active={cursor === flatIdx}
              editing={editing?.fieldKey === fieldKey(f)}
              value={token}
              editValue={
                editing?.fieldKey === fieldKey(f) ? editing.value : undefined
              }
              onChange={(v) =>
                setEditing(editing ? { ...editing, value: v } : null)
              }
              onSubmit={submitEdit}
            />
          );
        })}
        <FieldRow
          active={cursor === argsTokens.length}
          editing={editing?.fieldKey === 'argsAdd'}
          value="+ Add arg"
          placeholderColor="green"
          editValue={
            editing?.fieldKey === 'argsAdd' ? editing.value : undefined
          }
          onChange={(v) =>
            setEditing(editing ? { ...editing, value: v } : null)
          }
          onSubmit={submitEdit}
        />

        <SectionHeader label="Env" topMargin shadowed={shadowFlags.env} />
        {envKeys.map((k, idx) => {
          const f: Field = { kind: 'envToken', key: k };
          const flatIdx = argsTokens.length + 1 + idx;
          return (
            <FieldRow
              key={`env-${k}`}
              active={cursor === flatIdx}
              editing={editing?.fieldKey === fieldKey(f)}
              value={`${k}=${scopeView.env[k] ?? ''}`}
              editValue={
                editing?.fieldKey === fieldKey(f) ? editing.value : undefined
              }
              onChange={(v) =>
                setEditing(editing ? { ...editing, value: v } : null)
              }
              onSubmit={submitEdit}
            />
          );
        })}
        <FieldRow
          active={cursor === argsTokens.length + 1 + envKeys.length}
          editing={editing?.fieldKey === 'envAdd'}
          value="+ Add env var"
          placeholderColor="green"
          editValue={editing?.fieldKey === 'envAdd' ? editing.value : undefined}
          onChange={(v) =>
            setEditing(editing ? { ...editing, value: v } : null)
          }
          onSubmit={submitEdit}
        />

        <SectionHeader label="Defaults" topMargin />
        {myDefaults.map((a) => (
          <DefaultItem key={a.name} name={a.name} shadowed={a.shadowed} />
        ))}
        {claimable.length > 0 && (
          <FieldRow
            active={cursor === argsTokens.length + 2 + envKeys.length}
            editing={false}
            value={
              myDefaults.length > 0 ? '+ Claim more...' : '+ Claim default...'
            }
            placeholderColor="green"
            editValue={undefined}
            onChange={() => {}}
            onSubmit={() => {}}
          />
        )}
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      {anyShadow && projectConfigPath && (
        <Box marginTop={1}>
          <Text dimColor>
            † Project config at {projectConfigPath} overrides here
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {editing
            ? '↵ save  esc cancel edit'
            : '↑↓ navigate  ↵ edit  x delete  esc back'}
        </Text>
      </Box>
    </Box>
  );
}

function SectionHeader({
  label,
  topMargin,
  shadowed,
}: {
  label: string;
  topMargin?: boolean;
  shadowed?: boolean;
}) {
  return (
    <Box marginTop={topMargin ? 1 : 0}>
      <Text>{'  '}</Text>
      <Text dimColor>{label}</Text>
      {shadowed && <Text dimColor> †</Text>}
    </Box>
  );
}

function FieldRow({
  active,
  editing,
  value,
  editValue,
  placeholderColor,
  onChange,
  onSubmit,
}: {
  active: boolean;
  editing: boolean;
  value: string;
  editValue?: string;
  placeholderColor?: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
}) {
  const color = active ? 'cyan' : undefined;
  return (
    <Box>
      <Text>{'    '}</Text>
      <Text color={color}>{active ? '> ' : '  '}</Text>
      {editing && editValue !== undefined ? (
        <TextInput
          value={editValue}
          onChange={onChange}
          onSubmit={() => onSubmit(editValue)}
        />
      ) : (
        <Text color={placeholderColor} dimColor={!active && !placeholderColor}>
          {value}
        </Text>
      )}
    </Box>
  );
}

function DefaultItem({ name, shadowed }: { name: string; shadowed: boolean }) {
  return (
    <Box>
      <Text>{'      '}</Text>
      {shadowed ? (
        <>
          <Text dimColor strikethrough>
            {name}
          </Text>
          <Text dimColor> †</Text>
        </>
      ) : (
        <Text>{name}</Text>
      )}
    </Box>
  );
}

function ClaimDefaultMenu({
  profile,
  scope,
  claimable,
  hasProjectConfig,
  projectConfigPath,
  onPick,
  onCancel,
}: {
  profile: string;
  scope: EditScope;
  claimable: ClaimableDefault[];
  hasProjectConfig: boolean;
  projectConfigPath: string | null;
  onPick: (name: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });
  const items = [
    ...claimable.map((c) => ({
      label: `${c.name} (${
        c.current ? `claimed by ${c.current}` : 'unclaimed'
      })`,
      value: c.name,
    })),
    { label: 'Cancel', value: '__cancel__' },
  ];
  const willCreateProject = scope === 'project' && !hasProjectConfig;
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        Claim default for <Text color="cyan">{profile}</Text>
        <Text dimColor> ({scope} scope)</Text>
      </Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === '__cancel__') onCancel();
            else void onPick(item.value);
          }}
        />
      </Box>
      {willCreateProject && (
        <Box marginTop={1}>
          <Text dimColor>
            Note: claiming will create {projectConfigPath ?? './.agenv.json'}.
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>Esc: cancel</Text>
      </Box>
    </Box>
  );
}

function RemoveConfirm({
  profile,
  onConfirm,
  onCancel,
}: {
  profile: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text>
        Remove profile <Text bold>{profile}</Text>?
      </Text>
      <Text dimColor>This deletes installed files under this profile.</Text>
      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: 'No, keep it', value: 'no' },
            { label: 'Yes, remove', value: 'yes' },
          ]}
          onSelect={(item) => (item.value === 'yes' ? onConfirm() : onCancel())}
        />
      </Box>
    </Box>
  );
}
