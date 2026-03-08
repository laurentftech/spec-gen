function FToggle({ active, onChange, label, badge, activeColor = 'var(--ac-primary)' }) {
  return (
    <button
      onClick={() => onChange(!active)}
      style={{
        background: active ? `${activeColor}1a` : 'transparent',
        border: `1px solid ${active ? activeColor : 'var(--bd-muted)'}`,
        borderRadius: 4,
        color: active ? activeColor : 'var(--tx-ghost)',
        padding: '2px 8px',
        cursor: 'pointer',
        fontSize: 9,
        fontFamily: 'inherit',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      {label}
      {badge !== undefined && (
        <span
          style={{
            background: 'var(--bg-input)',
            borderRadius: 3,
            padding: '0 4px',
            color: 'var(--tx-ghost)',
            fontSize: 8,
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

export function FilterBar({ filters, setFilters, stats, clusterNames }) {
  const hasActive =
    filters.hideOrphans ||
    filters.minScore > 0 ||
    filters.topN < 999 ||
    filters.cluster !== '' ||
    filters.refactorOnly;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        padding: '7px 18px',
        borderBottom: '1px solid var(--bd-faint)',
        background: 'var(--bg-base)',
        flexShrink: 0,
        fontSize: 9,
      }}
    >
      <span style={{ color: 'var(--tx-faint)', letterSpacing: '0.08em', fontWeight: 700 }}>FILTERS</span>

      <FToggle
        active={filters.hideOrphans}
        onChange={(v) => setFilters((f) => ({ ...f, hideOrphans: v }))}
        label="Hide orphans"
        badge={stats.orphanCount}
        activeColor="#f77c6a"
      />

      <FToggle
        active={filters.refactorOnly}
        onChange={(v) => setFilters((f) => ({ ...f, refactorOnly: v }))}
        label="Nodes to refactor"
        badge={stats.refactorVisible}
        activeColor="#f97373"
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ color: 'var(--tx-faint)' }}>Score ≥</span>
        <input
          type="range"
          min={0}
          max={65}
          step={5}
          value={filters.minScore}
          onChange={(e) => setFilters((f) => ({ ...f, minScore: +e.target.value }))}
          style={{ width: 72, accentColor: 'var(--ac-primary)' }}
        />
        <span style={{ color: 'var(--ac-primary)', minWidth: 16 }}>{filters.minScore}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ color: 'var(--tx-faint)' }}>Top</span>
        <select
          value={filters.topN}
          onChange={(e) => setFilters((f) => ({ ...f, topN: +e.target.value }))}
          style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--bd-muted)',
            color: 'var(--tx-primary)',
            borderRadius: 4,
            padding: '2px 5px',
            fontSize: 9,
            fontFamily: 'inherit',
          }}
        >
          {[999, 50, 30, 20, 10].map((n) => (
            <option key={n} value={n}>
              {n === 999 ? 'All' : String(n)}
            </option>
          ))}
        </select>
        <span style={{ color: 'var(--tx-faint)' }}>nodes</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ color: 'var(--tx-faint)' }}>Cluster</span>
        <select
          value={filters.cluster}
          onChange={(e) => setFilters((f) => ({ ...f, cluster: e.target.value }))}
          style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--bd-muted)',
            color: 'var(--tx-primary)',
            borderRadius: 4,
            padding: '2px 5px',
            fontSize: 9,
            fontFamily: 'inherit',
            maxWidth: 130,
          }}
        >
          <option value="">All</option>
          {clusterNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>

      {hasActive && (
        <button
          onClick={() =>
            setFilters({
              hideOrphans: false,
              minScore: 0,
              topN: 999,
              cluster: '',
              refactorOnly: false,
            })
          }
          style={{
            background: 'none',
            border: '1px solid var(--tx-faint)',
            borderRadius: 4,
            color: 'var(--tx-ghost)',
            padding: '2px 7px',
            cursor: 'pointer',
            fontSize: 9,
            fontFamily: 'inherit',
          }}
        >
          reset
        </button>
      )}

      <div style={{ marginLeft: 'auto', color: 'var(--tx-faint)', display: 'flex', gap: 8 }}>
        <span>
          <span style={{ color: 'var(--ac-primary)' }}>{stats.visible}</span>/
          <span style={{ color: 'var(--tx-dim)' }}>{stats.total}</span> nodes
        </span>
        <span>
          <span style={{ color: 'var(--ac-teal)' }}>{stats.visibleEdges}</span> edges
        </span>
        {stats.orphanCount > 0 && !filters.hideOrphans && (
          <span style={{ color: '#f77c6a66' }}>{stats.orphanCount} orphans</span>
        )}
      </div>
    </div>
  );
}
