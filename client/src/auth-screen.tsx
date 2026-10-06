import { useState } from 'react';
import {
  Alert,
  Button,
  Center,
  Paper,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { OperatorApiError, type OperatorApi, type SessionInfo } from './operator-api';

const MIN_PASSWORD_LENGTH = 12;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 100;
const MAX_PASSWORD_LENGTH = 128;

type AuthMode = 'login' | 'register';

export interface AuthScreenProps {
  api: OperatorApi;
  notice: string | null;
  onNoticeDismissed(): void;
  onAuthenticated(session: SessionInfo): void;
}

/** Mirrors the operator's validation so invalid input never reaches the API. */
function validate(values: { name: string; email: string; password: string }, mode: AuthMode) {
  const errors: Partial<Record<'name' | 'email' | 'password', string>> = {};
  if (mode === 'register') {
    const name = values.name.trim();
    if (name.length === 0) errors.name = 'Informe seu nome.';
    else if (name.length > MAX_NAME_LENGTH) errors.name = `Use no máximo ${MAX_NAME_LENGTH} caracteres.`;
  }
  const email = values.email.trim();
  if (email.length === 0) errors.email = 'Informe seu email.';
  else if (email.length > MAX_EMAIL_LENGTH) errors.email = `Use no máximo ${MAX_EMAIL_LENGTH} caracteres.`;
  else if (!EMAIL_PATTERN.test(email)) errors.email = 'Informe um email válido.';

  if (values.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `A senha precisa de pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  } else if (values.password.length > MAX_PASSWORD_LENGTH) {
    errors.password = `Use no máximo ${MAX_PASSWORD_LENGTH} caracteres.`;
  }
  return errors;
}

function describeFailure(error: unknown): string {
  if (error instanceof OperatorApiError) {
    if (error.code === 'EMAIL_IN_USE') return 'Este email já está cadastrado. Use "Entrar".';
    if (error.code === 'INVALID_CREDENTIALS') return 'Email ou senha incorretos.';
    if (error.code === 'RATE_LIMITED' || error.status === 429) {
      return 'Muitas tentativas em pouco tempo. Aguarde e tente novamente.';
    }
    if (error.code === 'SERVICE_UNAVAILABLE' || error.status === 503) {
      return 'O serviço de autenticação está indisponível. Tente novamente em instantes.';
    }
    if (error.kind === 'network') return 'Não foi possível falar com o operador. Verifique a conexão.';
    return error.message;
  }
  return 'Não foi possível concluir a operação. Tente novamente.';
}

export function AuthScreen({
  api,
  notice,
  onNoticeDismissed,
  onAuthenticated,
}: AuthScreenProps): React.JSX.Element {
  const [mode, setMode] = useState<AuthMode>('login');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm({
    initialValues: { name: '', email: '', password: '' },
    validate: (values) => validate(values, mode),
  });

  const handleSubmit = form.onSubmit(async (values) => {
    setFormError(null);
    setSubmitting(true);
    const email = values.email.trim();
    try {
      if (mode === 'register') {
        await api.register({ name: values.name.trim(), email, password: values.password });
        try {
          const session = await api.login({ email, password: values.password });
          onAuthenticated(session);
          return;
        } catch (loginError) {
          // The account exists even though the automatic sign-in failed.
          setMode('login');
          form.setFieldValue('password', '');
          setFormError(`Sua conta foi criada. Entre com a senha para continuar. (${describeFailure(loginError)})`);
          return;
        }
      }
      const session = await api.login({ email, password: values.password });
      onAuthenticated(session);
    } catch (error) {
      setFormError(describeFailure(error));
    } finally {
      setSubmitting(false);
    }
  });

  const switchMode = (next: AuthMode): void => {
    setMode(next);
    setFormError(null);
    onNoticeDismissed();
  };

  return (
    <Center mih="100dvh" p="md">
      <Paper withBorder shadow="sm" p="lg" radius="md" w={440} maw="100%">
        <Stack gap="md">
          <div>
            <Title order={2}>Crashsim</Title>
            <Text size="sm" c="dimmed">
              Entre com sua conta para jogar e movimentar sua carteira.
            </Text>
          </div>

          <SegmentedControl
            fullWidth
            value={mode}
            onChange={(value) => switchMode(value as AuthMode)}
            data={[
              { label: 'Entrar', value: 'login' },
              { label: 'Criar conta', value: 'register' },
            ]}
          />

          {notice !== null && (
            <Alert color="blue" withCloseButton onClose={onNoticeDismissed} title="Aviso">
              {notice}
            </Alert>
          )}

          {formError !== null && (
            <Alert color="red" title="Não foi possível continuar">
              {formError}
            </Alert>
          )}

          <form onSubmit={handleSubmit} noValidate>
            <Stack gap="sm">
              {mode === 'register' && (
                <TextInput
                  label="Nome"
                  placeholder="Como devemos chamar você"
                  autoComplete="name"
                  required
                  {...form.getInputProps('name')}
                />
              )}
              <TextInput
                label="Email"
                placeholder="voce@exemplo.com"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                {...form.getInputProps('email')}
              />
              <PasswordInput
                label="Senha"
                description={mode === 'register' ? `Pelo menos ${MIN_PASSWORD_LENGTH} caracteres.` : undefined}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                required
                {...form.getInputProps('password')}
              />
              <Button type="submit" loading={submitting} fullWidth mt="xs">
                {mode === 'register' ? 'Criar conta e entrar' : 'Entrar'}
              </Button>
            </Stack>
          </form>

          <Text size="xs" c="dimmed">
            Ambiente local de desenvolvimento. Saldo, top-up e saque são operações de teste.
          </Text>
        </Stack>
      </Paper>
    </Center>
  );
}
