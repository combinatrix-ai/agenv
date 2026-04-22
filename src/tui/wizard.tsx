import { type ReactNode, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';

export interface WizardResult {
  agent: 'codex' | 'claude' | 'gemini';
  profile: string;
  yolo: boolean;
}

interface WizardProps {
  existingProfiles: string[];
  onSubmit: (result: WizardResult) => void;
  onCancel: () => void;
}

type Step = 'agent' | 'name' | 'yolo' | 'confirm';

const AGENT_ITEMS: Array<{
  label: string;
  value: 'codex' | 'claude' | 'gemini';
  hint: string;
}> = [
  { label: 'codex', value: 'codex', hint: 'OpenAI Codex CLI' },
  { label: 'claude', value: 'claude', hint: 'Anthropic Claude Code' },
  { label: 'gemini', value: 'gemini', hint: 'Google Gemini CLI' },
];

const YOLO_ITEMS = [
  { label: 'No — default (recommended)', value: 'no' },
  {
    label: 'Yes — add auto-approve args (--yolo / --full-auto / skip perms)',
    value: 'yes',
  },
];

export default function Wizard({
  existingProfiles,
  onSubmit,
  onCancel,
}: WizardProps) {
  const [step, setStep] = useState<Step>('agent');
  const [agent, setAgent] = useState<WizardResult['agent']>('codex');
  const [profile, setProfile] = useState<string>('codex');
  const [nameEdited, setNameEdited] = useState(false);
  const [yolo, setYolo] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  const validateName = (name: string): string | null => {
    if (!name) return 'Profile name is required.';
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
      return 'Use lowercase letters, numbers, "-" or "_".';
    }
    if (existingProfiles.includes(name)) {
      return `Profile "${name}" already exists.`;
    }
    return null;
  };

  if (step === 'agent') {
    return (
      <Frame title="New profile — step 1/4: choose agent">
        <SelectInput
          items={AGENT_ITEMS.map((item) => ({
            label: `${item.label.padEnd(8)} ${item.hint}`,
            value: item.value,
          }))}
          onSelect={(item) => {
            const picked = item.value as WizardResult['agent'];
            setAgent(picked);
            if (!nameEdited) setProfile(picked);
            setStep('name');
          }}
        />
        <Hint text="Esc: cancel" />
      </Frame>
    );
  }

  if (step === 'name') {
    return (
      <Frame title="New profile — step 2/4: profile name">
        <Box>
          <Text>name: </Text>
          <TextInput
            value={profile}
            onChange={(value) => {
              setNameEdited(true);
              setProfile(value);
              setNameError(validateName(value));
            }}
            onSubmit={() => {
              const err = validateName(profile);
              if (err) {
                setNameError(err);
                return;
              }
              setStep('yolo');
            }}
          />
        </Box>
        {nameError && (
          <Box marginTop={1}>
            <Text color="red">{nameError}</Text>
          </Box>
        )}
        <Hint text="Enter: next   Esc: cancel" />
      </Frame>
    );
  }

  if (step === 'yolo') {
    return (
      <Frame title="New profile — step 3/4: auto-approve (yolo)?">
        <Text dimColor>
          Adds agent-specific args so the agent runs without asking for
          permissions. You can change this later with `agenv edit global`.
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={YOLO_ITEMS}
            onSelect={(item) => {
              setYolo(item.value === 'yes');
              setStep('confirm');
            }}
          />
        </Box>
        <Hint text="Esc: cancel" />
      </Frame>
    );
  }

  return (
    <Frame title="New profile — step 4/4: confirm">
      <Summary profile={profile} agent={agent} yolo={yolo} />
      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: 'Install', value: 'install' },
            { label: 'Back', value: 'back' },
            { label: 'Cancel', value: 'cancel' },
          ]}
          onSelect={(item) => {
            if (item.value === 'install') {
              onSubmit({ agent, profile, yolo });
            } else if (item.value === 'back') {
              setStep('yolo');
            } else {
              onCancel();
            }
          }}
        />
      </Box>
      <Hint text="Esc: cancel" />
    </Frame>
  );
}

function Frame({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {title}
        </Text>
      </Box>
      {children}
    </Box>
  );
}

function Hint({ text }: { text: string }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}

function Summary({
  profile,
  agent,
  yolo,
}: {
  profile: string;
  agent: string;
  yolo: boolean;
}) {
  return (
    <Box flexDirection="column">
      <Line label="profile" value={profile} />
      <Line label="agent" value={agent} />
      <Line label="yolo" value={yolo ? 'yes (auto-approve)' : 'no'} />
    </Box>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Box width={10}>
        <Text dimColor>{label}:</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}
