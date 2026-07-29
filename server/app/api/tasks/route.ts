import { NextRequest, NextResponse } from 'next/server';
import { getParticipantTrials, withResultsLock } from '@/lib/results';
import { getTrialConfigs } from '@/lib/manifest';
import { generateTrials } from '@/lib/trials';
import { isValidParticipant } from '@/lib/participants';
import { getSyntheticTaskUrl, getSyntheticTrialConfigs } from '@/lib/synthetic-websites';
import type { Trial, TrialConfigEntry } from '@/types';

function trialsMatchConfigs(trials: Trial[], configs: TrialConfigEntry[]): boolean {
  return trials.length === configs.length
    && trials.every((trial, index) => trial.slug === configs[index]?.slug);
}

async function attachSyntheticUrls(configs: TrialConfigEntry[]) {
  const urlCache = new Map<string, Promise<string>>();

  return Promise.all(configs.map(async (config) => {
    const cacheKey = `${config.group}\n${config.plain_app}\n${config.start_path || '/'}`;
    let url = urlCache.get(cacheKey);
    if (!url) {
      url = getSyntheticTaskUrl(config);
      urlCache.set(cacheKey, url);
    }
    return {
      task_prompt: config.task_prompt,
      site_url: await url,
      group: config.group,
      slug: config.slug,
    };
  }));
}

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

  const configs = websiteMode === 'synthetic'
    ? await getSyntheticTrialConfigs()
    : await getTrialConfigs();

  let trials = await getParticipantTrials(participantId);

  if (!trials || trials.length === 0 || !trialsMatchConfigs(trials, configs)) {
    trials = await withResultsLock(async (data) => {
      if (data[participantId]?.trials?.length > 0 && trialsMatchConfigs(data[participantId].trials, configs)) {
        return data[participantId].trials;
      }
      const generated = generateTrials(configs);
      data[participantId] = { trials: generated };
      return generated;
    });
  }

  const baseTasks = configs.map((config) => ({
    task_prompt: config.task_prompt,
    site_url: config.site_url ?? '',
    group: config.group,
    slug: config.slug,
  }));
  const tasks = websiteMode === 'synthetic'
    ? await attachSyntheticUrls(configs)
    : baseTasks;

  const currentTaskIndex = trials!.findIndex(t => !t.completed);

  return NextResponse.json({
    tasks,
    currentTaskIndex: currentTaskIndex === -1 ? tasks.length : currentTaskIndex,
    totalTasks: tasks.length,
    websiteMode,
  });
}
