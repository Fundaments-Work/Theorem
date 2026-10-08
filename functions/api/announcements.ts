export async function onRequestGet(): Promise<Response> {
    return new Response(
        JSON.stringify({
            announcements: [],
            updatedAt: new Date().toISOString(),
        }),
        {
            status: 200,
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Accept",
                "Cache-Control": "public, max-age=300, s-maxage=3600",
            },
        }
    );
}

export async function onRequestOptions(): Promise<Response> {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Accept",
            "Access-Control-Max-Age": "86400",
        },
    });
}
