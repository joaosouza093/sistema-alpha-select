// Tarefa agendada: remove sessões expiradas, tokens vencidos e contadores antigos.
import { handleMaintenance } from '../../server/src/serverless.ts';

process.env.SUPABASE_REGION ??= 'sa-east-1';

export default async () => {
  await handleMaintenance();
};

export const config = { schedule: '@hourly' };
