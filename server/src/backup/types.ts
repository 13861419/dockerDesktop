/** 备份对象类型 */
export type BackupKind = 'database' | 'volume' | 'compose' | 'site';

/** 备份记录状态 */
export type BackupStatus = 'ready' | 'restoring' | 'failed';

/** 备份清单记录 */
export interface BackupManifest {
  id: string;
  kind: BackupKind;
  name: string;
  source: string;
  filePath: string;
  size: number;
  status: BackupStatus;
  createdAt: number;
  updatedAt: number;
}

/** 新增备份记录输入 */
export interface BackupManifestInput {
  id?: string;
  kind: BackupKind;
  name: string;
  source: string;
  filePath: string;
  size: number;
  status?: BackupStatus;
  createdAt?: number;
  updatedAt?: number;
}
