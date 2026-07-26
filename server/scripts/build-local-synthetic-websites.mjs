import fs from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const dataDir = path.join(cwd, 'data');
const configDir = path.join(cwd, 'config');
const trialsConfigPath = path.join(configDir, 'trials-config.json');
const outputRoot = path.join(dataDir, 'synthetic-websites');

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function pageHtml(task) {
  const title = escapeHtml(task.group || task.slug);
  const prompt = escapeHtml(task.task_prompt);
  const sourceUrl = task.site_url ? escapeHtml(task.site_url) : '';
  const steps = Array.isArray(task.suggested_flows) ? task.suggested_flows : [];
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} synthetic</title>
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(255, 237, 213, 0.8), transparent 32%),
          linear-gradient(160deg, #f7f4ec 0%, #eef6ff 100%);
        color: #111827;
      }
      main {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .card {
        width: min(760px, 100%);
        background: rgba(255,255,255,0.92);
        border: 1px solid #e5e7eb;
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 18px 50px rgba(15, 23, 42, 0.08);
      }
      .eyebrow {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #92400e;
        margin-bottom: 10px;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 32px;
        line-height: 1.1;
      }
      p, li {
        line-height: 1.6;
        color: #374151;
      }
      .source {
        margin-top: 18px;
        padding: 12px 14px;
        border-radius: 12px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        font-size: 14px;
        word-break: break-all;
      }
      .chips {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin: 20px 0;
      }
      .chip {
        padding: 8px 12px;
        border-radius: 999px;
        background: #e0f2fe;
        color: #075985;
        font-size: 13px;
        font-weight: 600;
      }
      ol {
        margin: 16px 0 0;
        padding-left: 20px;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="card">
        <div class="eyebrow">Synthetic Website</div>
        <h1>${title}</h1>
        <p>This local test website was prebuilt ahead of time and is hosted by website-service.</p>
        <p><strong>Task:</strong> ${prompt}</p>
        <div class="chips">
          <span class="chip">Prebuilt local bundle</span>
          <span class="chip">Hosted by website-service</span>
        </div>
        ${steps.length > 0 ? `<ol>${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>` : ''}
        ${sourceUrl ? `<div class="source"><strong>Original real website:</strong> ${sourceUrl}</div>` : ''}
      </section>
    </main>
  </body>
</html>`;
}

async function main() {
  const tasks = JSON.parse(await fs.readFile(trialsConfigPath, 'utf8'));
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(`Expected a non-empty task array in ${trialsConfigPath}`);
  }

  await fs.mkdir(outputRoot, { recursive: true });

  for (const task of tasks) {
    const slug = String(task.slug || '').trim();
    if (!slug) throw new Error('Each task must include a slug');

    const websiteDir = path.join(outputRoot, slug);
    const distDir = path.join(websiteDir, 'dist');
    await fs.mkdir(distDir, { recursive: true });

    await fs.writeFile(path.join(distDir, 'index.html'), pageHtml(task), 'utf8');
    await fs.writeFile(path.join(websiteDir, 'trials-config.json'), JSON.stringify([{
      slug,
      group: String(task.group || slug),
      task_prompt: String(task.task_prompt || ''),
      start_path: '/',
      suggested_flows: Array.isArray(task.suggested_flows) ? task.suggested_flows : [],
      site_url: typeof task.site_url === 'string' ? task.site_url : '',
    }], null, 2), 'utf8');
  }

  console.log(`Built ${tasks.length} local synthetic websites in ${outputRoot}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
