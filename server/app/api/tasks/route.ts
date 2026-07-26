import { NextRequest, NextResponse } from 'next/server';
import { getParticipantTrials, withResultsLock } from '@/lib/results';
import { getTrialConfigs } from '@/lib/manifest';
import { generateTrials } from '@/lib/trials';
import { isValidParticipant } from '@/lib/participants';
import { TRIALS_CONFIG_PATH } from '@/lib/paths';
import { getSyntheticTaskUrl } from '@/lib/synthetic-websites';
import fs from 'fs/promises';

export async function GET(req: NextRequest) {
  const participantId = req.nextUrl.searchParams.get('participantId');
  const websiteMode = req.nextUrl.searchParams.get('websiteMode') || 'real';
  if (!participantId) {
    return NextResponse.json({ error: 'Missing participantId' }, { status: 400 });
  }
  if (!['real', 'synthetic'].includes(websiteMode)) {
    return NextResponse.json({ error: 'Invalid websiteMode' }, { status: 400 });
  }

  const valid = await isValidParticipant(participantId);
  if (!valid) {
    return NextResponse.json({ error: 'Invalid participant ID' }, { status: 404 });
  }

  let trials = await getParticipantTrials(participantId);

  if (!trials || trials.length === 0) {
    trials = await withResultsLock(async (data) => {
      if (data[participantId]?.trials?.length > 0) return data[participantId].trials;
      const configs = await getTrialConfigs();
      const generated = generateTrials(configs);
      data[participantId] = { trials: generated };
      return generated;
    });
  }

  const trialsConfig = JSON.parse(await fs.readFile(TRIALS_CONFIG_PATH, 'utf-8'));

  const baseTasks = trialsConfig.map((config: { task_prompt: string; site_url?: string; group: string; slug: string }) => ({
    task_prompt: config.task_prompt,
    site_url: config.site_url ?? '',
    group: config.group,
    slug: config.slug,
  }));
  const tasks = websiteMode === 'synthetic'
    ? await Promise.all(baseTasks.map(async (task: {
      task_prompt: string;
      site_url: string;
      group: string;
      slug: string;
    }) => ({
      ...task,
      site_url: await getSyntheticTaskUrl(task),
    })))
    : baseTasks;

  const currentTaskIndex = trials!.findIndex(t => !t.completed);

  return NextResponse.json({
    tasks,
    currentTaskIndex: currentTaskIndex === -1 ? tasks.length : currentTaskIndex,
    totalTasks: tasks.length,
    websiteMode,
  });
}
