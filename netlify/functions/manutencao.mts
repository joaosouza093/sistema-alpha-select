// Tarefa agendada: remove sessões expiradas, tokens vencidos e contadores antigos.
import { handleMaintenance } from '../../server/src/serverless.ts';

export default async () => {
  await handleMaintenance();
};

export const config = { schedule: '@hourly' };
