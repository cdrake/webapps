/**
 * SeedSegInputSet
 *
 * Handles single T1-weighted MRI file input for prostate segmentation.
 * Unified input — accepts NIfTI or converted DICOM.
 */

export class SeedSegInputSet {
  constructor(options) {
    this.updateOutput = options.updateOutput || (() => {});
    this.onFileLoaded = options.onFileLoaded || (() => {});

    this.activeFile = null;
  }

  getActiveFile() {
    return this.activeFile;
  }

  hasValidData() {
    return this.activeFile !== null;
  }

  setFile(file) {
    this.activeFile = file;
    return this.onFileLoaded(file);
  }

  clearFile() {
    this.activeFile = null;
  }
}
