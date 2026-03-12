import { parseGraph } from './graph-helpers.js';

describe('parseGraph', () => {
  it('should parse structuralClusters and directoryClusters from raw data', () => {
    const raw = {
      nodes: [],
      edges: [],
      clusters: [],
      structuralClusters: [
        { id: 'cluster1', name: 'Structural Cluster 1', files: ['file1.js'], color: '#ff0000' },
      ],
      directoryClusters: [
        { id: 'dir1', name: 'Directory Cluster 1', files: ['dir/file.js'], color: '#00ff00' },
      ],
      statistics: {},
      rankings: {},
    };

    const result = parseGraph(raw);

    expect(result.structuralClusters).toEqual(raw.structuralClusters);
    expect(result.directoryClusters).toEqual(raw.directoryClusters);
  });

  it('should provide empty arrays for missing structuralClusters and directoryClusters', () => {
    const raw = {
      nodes: [],
      edges: [],
      clusters: [],
      statistics: {},
      rankings: {},
    };

    const result = parseGraph(raw);

    expect(result.structuralClusters).toEqual([]);
    expect(result.directoryClusters).toEqual([]);
  });
});