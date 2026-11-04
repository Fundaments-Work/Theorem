import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { Session } from './webdriver.mjs';

async function withDriver(delay, run) {
    const server = createServer((_request, response) => {
        const timer = setTimeout(() => {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ value: 'UE5H' }));
        }, delay);
        response.on('close', () => clearTimeout(timer));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await run(`http://127.0.0.1:${server.address().port}`);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

test('a stalled screenshot is cancelled within its request budget', async () => {
    await withDriver(150, async base => {
        const session = new Session(base, 'fixture', { requestTimeoutMs: 25 });
        await assert.rejects(session.screenshot(), { name: 'TimeoutError' });
    });
});

test('a healthy screenshot retains its returned bytes', async () => {
    await withDriver(0, async base => {
        const session = new Session(base, 'fixture', { requestTimeoutMs: 1000 });
        assert.equal((await session.screenshot()).toString(), 'PNG');
    });
});
