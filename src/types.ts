export type PatchRecord = {
  file: string;
  profile: string;
  path: string;
  value: string;
};

export type FileEntry = {
  path: string;
  profiles: string[];
};

export type TreeNode = {
  key: string;
  path: string;
  type: string;
  valuePreview: string;
  children?: TreeNode[];
};
