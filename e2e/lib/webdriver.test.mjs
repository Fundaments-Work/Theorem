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

test('clicking an option centers its select before the native click, clear of a reminder toast', async () => {
    let centered = false;
    let nativeClicks = 0;
    const select = { scrollIntoView(options) { centered = options.block === 'center'; } };
    const option = { tagName: 'OPTION', closest(tag) { assert.equal(tag, 'select'); return select; } };
    const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const payload = JSON.parse(body || '{}');
        res.setHeader('content-type', 'application/json');
        if (req.url.endsWith('/execute/sync')) {
            Function(payload.script)(option);
            res.end(JSON.stringify({ value: null }));
        } else if (req.url.endsWith('/element/option/click')) {
            nativeClicks++;
            res.statusCode = centered ? 200 : 400;
            res.end(JSON.stringify({ value: centered ? null : { error: 'element click intercepted', message: 'Reading reminder covers the select at the viewport edge' } }));
        } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ value: { error: 'unknown command' } }));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const session = new Session(`http://127.0.0.1:${server.address().port}`, 'fixture');
        await session.click({ 'element-6066-11e4-a52e-4f735466cecf': 'option' });
        assert.equal(centered, true);
        assert.equal(nativeClicks, 1);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
