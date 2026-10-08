import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
  onFiles(files: File[]): void;
  accept?: string;
  multiple?: boolean;
  directory?: boolean;
  className?: string;
}

/** A button-styled label wrapping a hidden file input. */
export function FileButton({ children, onFiles, accept, multiple, directory, className = "btn" }: Props) {
  const dirProps = directory ? ({ webkitdirectory: "", directory: "" } as Record<string, string>) : {};
  return (
    <label className={className} style={{ cursor: "pointer" }}>
      {children}
      <input
        type="file"
        accept={accept}
        multiple={multiple || directory}
        {...dirProps}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </label>
  );
}
