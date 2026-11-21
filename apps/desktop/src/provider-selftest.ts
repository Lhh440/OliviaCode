import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  findProviderModel,
  parseModelKey,
  providerKeyName,
  providerModelKey,
  providerModelOptions,
  validateProviderDraft,
  type ProviderConfig,
  type ProviderDraft,
} from '@olivia/core';
import { fetchProviderModels, testProviderConnection } from './provider-test';
import { ProviderStore } from './provider-store';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function draft(patch: Partial<ProviderDraft> = {}): ProviderDraft {
  return {
    id: 'local-gateway',
    name: '本地网关',
    baseUrl: 'http://127.0.0.1:65530/v1/',
    protocol: 'openai-chat',
    models: [{ id: 'mock-a', label: 'Mock A', contextWindow: 32000, vision: true }],
    ...patch,
  };
}

function testValidation(): void {
  console.log('provider validation / keys');
  check('valid draft accepted', validateProviderDraft(draft()) === null);
  check('uppercase id rejected', validateProviderDraft(draft({ id: 'BadID' })) !== null);
  check('empty name rejected', validateProviderDraft(draft({ name: '  ' })) !== null);
  check('non-http URL rejected', validateProviderDraft(draft({ baseUrl: 'ftp://x' })) !== null);
  check(
    'duplicate model rejected',
    validateProviderDraft(draft({ models: [{ id: 'mock-a' }, { id: 'mock-a' }] })) !== null,
  );
  check(
    'bad context window rejected',
    validateProviderDraft(draft({ models: [{ id: 'mock-a', contextWindow: 12 }] })) !== null,
  );
  check('model key round-trips', parseModelKey(providerModelKey('p', 'm')).providerId === 'p');
  check('plain model key has no provider', parseModelKey('m').providerId === undefined);
  check('vault key name is stable', providerKeyName(' p ') === 'provider:p');
}

function testOptions(): void {
  console.log('model options');
  const providers: ProviderConfig[] = [
    {
      id: 'a',
      name: 'A',
      baseUrl: 'http://a/v1',
      protocol: 'openai-chat',
      enabled: true,
      models: [{ id: 'm1', label: '模型一', vision: true }, { id: 'm2' }],
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: 'b',
      name: 'B',
      baseUrl: 'http://b/v1',
      protocol: 'openai-chat',
      enabled: false,
      models: [{ id: 'm3' }],
      createdAt: 0,
      updatedAt: 0,
    },
  ];
  const options = providerModelOptions(providers);
  check('only enabled providers listed', options.length === 2 && options.every((item) => item.providerId === 'a'));
  check('label falls back to id', options.find((item) => item.modelId === 'm2')?.label === 'm2');
  check('vision flag preserved', options.find((item) => item.modelId === 'm1')?.vision === true);
  check('findProviderModel resolves', findProviderModel(providers, 'a', 'm1')?.model?.label === '模型一');
  check('findProviderModel rejects unknown provider', findProviderModel(providers, 'x', 'm1') === null);
}

async function testStore(): Promise<void> {
  console.log('provider store');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'olivia-provider-'));
  const store = new ProviderStore(path.join(dir, 'providers.json'));
  const initial = await store.list();
  check('seeded defaults exist', initial.length > 0);
  const seededCount = initial.length;

  const saved = await store.save(draft());
  check('save ok', saved.ok);
  check('save trims trailing slash', saved.providers?.find((item) => item.id === 'local-gateway')?.baseUrl === 'http://127.0.0.1:65530/v1');
  check('save adds provider', saved.providers?.length === seededCount + 1);
  check('save marks vision', saved.providers?.find((item) => item.id === 'local-gateway')?.models[0]?.vision === true);
  check('hasKey not persisted', saved.providers?.every((item) => item.hasKey === undefined) === true);

  const updated = await store.save(draft({ name: '改名', models: [{ id: 'mock-b' }] }));
  check('update replaces models', updated.providers?.find((item) => item.id === 'local-gateway')?.models[0]?.id === 'mock-b');
  check('update keeps id', Boolean(updated.providers?.find((item) => item.id === 'local-gateway')));
  check('get returns provider', (await store.get('local-gateway'))?.name === '改名');

  const disabled = await store.setEnabled('local-gateway', false);
  check('disable works', disabled.find((item) => item.id === 'local-gateway')?.enabled === false);
  const removed = await store.remove('local-gateway');
  check('remove works', !removed.some((item) => item.id === 'local-gateway'));
  for (const provider of removed) await store.remove(provider.id);
  check('empty provider list stays empty', (await store.list()).length === 0);

  const raw = await fs.readFile(path.join(dir, 'providers.json'), 'utf8');
  check('providers.json has no api key fields', !raw.includes('apiKey') && !raw.includes('sk-'));
  await fs.rm(dir, { recursive: true, force: true });
}

async function testHttp(): Promise<void> {
  console.log('provider HTTP');
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      if (request.headers.authorization !== 'Bearer sk-test') {
        response.writeHead(401).end('{"error":"bad key"}');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-a' }, { id: 'mock-b' }] }));
      return;
    }
    response.writeHead(404).end('{"error":"not found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const listing = await fetchProviderModels(baseUrl, 'sk-test');
  check('models listed', listing.ok && listing.models?.length === 2);
  const denied = await fetchProviderModels(baseUrl, 'wrong');
  check('401 surfaced', !denied.ok && denied.status === 401);

  const connection = await testProviderConnection({
    draft: {
      id: 'local',
      name: 'Local',
      baseUrl,
      protocol: 'openai-chat',
      enabled: true,
      models: [{ id: 'mock-a' }],
      createdAt: 0,
      updatedAt: 0,
    },
    apiKey: 'sk-test',
  });
  check('connection test reports key works', connection.ok && connection.keyWorks === true);
  check('connection test lists models', connection.models?.length === 2);

  server.close();
}

async function main(): Promise<void> {
  testValidation();
  testOptions();
  await testStore();
  await testHttp();
  console.log(`\nM8 provider self-test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
