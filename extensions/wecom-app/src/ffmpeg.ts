import { spawn } from 'node:child_process';

export async function hasFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

export async function transcodeToAmr(params: {
  inputPath: string;
  outputPath: string;
}): Promise<void> {
  // amr_nb requires 8kHz mono in most WeCom clients
  const args = ['-y', '-i', params.inputPath, '-ar', '8000', '-ac', '1', '-c:a', 'amr_nb', params.outputPath];

  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr?.on('data', (d) => (err += String(d)));
    p.on('error', (e) => reject(e));
    p.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg transcode failed (code=${code}): ${err.slice(0, 2000)}`));
    });
  });
}
