declare module "./server" {}

export declare const httpAction: <T>(
  handler: (ctx: any, req: Request) => Promise<Response> | Response
) => (req: Request) => Promise<Response>;
