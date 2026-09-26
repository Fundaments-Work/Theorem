// Gutenberg's download redirects do not send CORS headers. Serve its catalog
// resources from the app's origin so browser clients can read the response.
function isAllowedGutenbergUrl(url: URL): boolean {
    return url.protocol === "https:"
        && (url.hostname === "www.gutenberg.org" || url.hostname === "gutenberg.org" || url.hostname === "m.gutenberg.org")
        && !url.username
        && !url.password
        && !url.port
        && (
            url.pathname === "/ebooks"
            || url.pathname.startsWith("/ebooks/")
            || url.pathname === "/ebooks.opds"
            || url.pathname.startsWith("/ebooks.opds/")
            || url.pathname.startsWith("/cache/epub/")
        );
}

export async function onRequestGet({ request }: { request: Request }): Promise<Response> {
    const requestedUrl = new URL(request.url).searchParams.get("url");
    if (!requestedUrl) return new Response("Missing Gutenberg URL", { status: 400 });

    let url: URL;
    try {
        url = new URL(requestedUrl);
    } catch {
        return new Response("Invalid Gutenberg URL", { status: 400 });
    }

    for (let redirects = 0; redirects <= 5; redirects++) {
        if (!isAllowedGutenbergUrl(url)) {
            return new Response("Gutenberg URL not allowed", { status: 400 });
        }

        let upstream: Response;
        try {
            upstream = await fetch(url, { redirect: "manual" });
        } catch {
            return new Response("Could not reach Project Gutenberg", { status: 502 });
        }

        const isRedirect = [301, 302, 303, 307, 308].includes(upstream.status);
        if (isRedirect) {
            const location = upstream.headers.get("location");
            if (!location) return new Response("Gutenberg redirect has no destination", { status: 502 });
            try {
                url = new URL(location, url);
            } catch {
                return new Response("Invalid Gutenberg redirect", { status: 502 });
            }
            continue;
        }

        if (!upstream.ok) {
            return new Response(`Project Gutenberg returned ${upstream.status}`, { status: upstream.status });
        }

        const headers = new Headers();
        for (const name of ["content-type", "last-modified", "etag", "cache-control"]) {
            const value = upstream.headers.get(name);
            if (value) headers.set(name, value);
        }
        return new Response(upstream.body, { status: 200, headers });
    }

    return new Response("Too many Gutenberg redirects", { status: 502 });
}
