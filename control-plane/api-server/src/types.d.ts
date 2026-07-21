/* eslint-disable @typescript-eslint/no-explicit-any */

declare module "@temporalio/client" {
  export interface ConnectionOptions {
    address: string;
    tls?: {
      clientCertPair: {
        crt: Buffer;
        key: Buffer;
      };
    };
  }

  export class Connection {
    static connect(options: ConnectionOptions): Promise<Connection>;
    close(): void;
  }

  export interface WorkflowStartOptions {
    args?: unknown[];
    taskQueue: string;
    workflowId: string;
    workflowExecutionTimeout?: string;
  }

  export class Client {
    constructor(options: { connection: Connection; namespace: string });
    workflow: {
      start(
        workflowType: string | ((...args: unknown[]) => any),
        options: WorkflowStartOptions
      ): Promise<WorkflowHandle>;
      getHandle(workflowId: string): WorkflowHandle;
      list(options: {
        query?: string;
        pageSize?: number;
      }): AsyncIterable<WorkflowExecutionInfo>;
    };
  }

  export interface WorkflowHandle {
    readonly workflowId: string;
    readonly firstExecutionRunId: string;
    describe(): Promise<WorkflowExecutionDescription>;
    fetchHistory(): Promise<{ events?: any[] }>;
    result<T = unknown>(): Promise<T>;
    signal(signalDef: any, ...args: unknown[]): Promise<void>;
    query(queryDef: any, ...args: unknown[]): Promise<any>;
    cancel(): Promise<void>;
    terminate(reason?: string): Promise<void>;
  }

  export interface WorkflowExecutionInfo {
    readonly workflowId: string;
    readonly type: string;
    readonly status: { name: string };
    readonly startTime: Date;
    readonly closeTime?: Date;
  }

  export interface WorkflowExecutionDescription {
    readonly workflowId: string;
    readonly status: { name: string };
    readonly startTime?: Date;
    readonly taskQueue?: string;
    readonly raw?: Record<string, unknown>;
  }
}
