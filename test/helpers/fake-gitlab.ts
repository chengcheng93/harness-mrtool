import type {
  GitLabHttpRequest,
  GitLabHttpResponse,
  GitLabHttpTransport,
} from "../../src/gitlab/http.ts";

interface FakeResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface RecordedGitLabRequest {
  readonly method: GitLabHttpRequest["method"];
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

function response(value: FakeResponse): GitLabHttpResponse {
  return {
    status: value.status ?? 200,
    headers: Object.freeze({ ...value.headers }),
    body: new TextEncoder().encode(JSON.stringify(value.body)),
  };
}

export class FakeGitLab implements GitLabHttpTransport {
  readonly requests: RecordedGitLabRequest[] = [];
  private readonly routes = new Map<string, FakeResponse[]>();

  enqueue(method: GitLabHttpRequest["method"], pathAndQuery: string, value: FakeResponse): void {
    const key = `${method} ${pathAndQuery}`;
    const values = this.routes.get(key) ?? [];
    values.push(value);
    this.routes.set(key, values);
  }

  async request(request: GitLabHttpRequest): Promise<GitLabHttpResponse> {
    const parsed = new URL(request.url);
    const key = `${request.method} ${parsed.pathname}${parsed.search}`;
    const values = this.routes.get(key);
    if (values === undefined || values.length === 0) {
      throw new Error(`Unexpected GitLab request: ${key}`);
    }
    const body = request.body === null
      ? null
      : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body)) as unknown;
    this.requests.push(Object.freeze({
      method: request.method,
      url: request.url,
      headers: Object.freeze({ ...request.headers }),
      body,
    }));
    const next = values.shift();
    if (next === undefined) throw new Error("Fake GitLab route was exhausted");
    return response(next);
  }
}
