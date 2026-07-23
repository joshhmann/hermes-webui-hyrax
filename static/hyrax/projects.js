/**
 * Hyraxknot Projects Panel
 * 
 * Displays project cards with progress bars, status breakdowns,
 * and task counts. Data from GET /api/hyrax/projects.
 */

async function loadProjects() {
  const content = document.getElementById('hyrax-projects-content');
  if (!content) return;
  content.innerHTML = '<p class="muted">Loading projects…</p>';
  
  try {
    const data = await api('/api/hyrax/projects');
    const projects = data?.items || [];
    
    if (!projects.length) {
      content.innerHTML = '<div class="empty"><p>No projects yet.</p><p class="muted">Set a project name when creating tasks to see them grouped here.</p></div>';
      return;
    }
    
    let html = '';
    projects.forEach(p => {
      const total = p.total || 0;
      const done = p.done_count || 0;
      const running = p.running_count || 0;
      const blocked = p.blocked_count || 0;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      
      html += '<div class="hyrax-project-card">';
      html += '<h3 class="hyrax-project-name">' + esc(p.name || 'Unnamed') + '</h3>';
      html += '<div class="hyrax-project-progress"><div class="hyrax-project-progress-fill" style="width:' + pct + '%"></div></div>';
      html += '<span class="hyrax-project-pct">' + done + '/' + total + ' done (' + pct + '%)</span>';
      html += '<div class="hyrax-project-stats">';
      if (running) html += '<span style="color:#58a6ff">● ' + running + ' running</span>';
      if (blocked) html += '<span style="color:#ff7b72">■ ' + blocked + ' blocked</span>';
      if (done) html += '<span style="color:#3fb950">✓ ' + done + ' done</span>';
      html += '</div></div>';
    });
    content.innerHTML = html;
  } catch (err) {
    content.innerHTML = '<div class="empty"><p>Failed to load projects.</p><p class="muted">' + esc(err.message || 'Unknown error') + '</p></div>';
  }
}
