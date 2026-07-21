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
      start(workflowType: any, options: WorkflowStartOptions): Promise<WorkflowHandle>;
      execute(workflowType: any, options: WorkflowStartOptions): Promise<any>;
      getHandle(workflowId: string): WorkflowHandle;
      list(options: { query?: string; pageSize?: number }): AsyncIterable<WorkflowExecutionInfo>;
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

declare module "@temporalio/workflow" {
  export function proxyActivities<T>(options: {
    startToCloseTimeout?: string | number;
    retry?: { maximumAttempts?: number; [key: string]: any };
    scheduleToStartTimeout?: string | number;
    heartbeatTimeout?: string | number;
  }): T;

  export function sleep(duration: string | number): Promise<void>;
  export function setHandler<T>(definition: any, handler: (...args: any[]) => any): void;
  export function defineSignal<T extends unknown[] = unknown[]>(name?: string): any;
  export function defineQuery<T = unknown>(name?: string): any;
  export function workflowInfo(): { workflowId: string; taskQueue: string; startTime: Date; [key: string]: any };
  export class ApplicationFailure {
    constructor(message: string, options?: { nonRetryable?: boolean; type?: string });
  }
  export function condition(fn: () => boolean, timeout?: string | number): Promise<boolean>;
}
