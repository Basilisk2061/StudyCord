import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiRequest } from '../lib/api';
import {
  createServerRequestGuard,
  deleteResourceRating,
  isBestMatchResult,
  putResourceRating,
  ratingErrorMessage,
  replaceRatingSummary,
  searchErrorMessage,
  searchServerResources,
} from '../lib/rag2Api';
import ResourceAccessPanel from './ResourceAccessPanel';
import ResourceSearchCard from './ResourceSearchCard';

export default function AdvancedSearchPanel({
  serverId,
  serverName,
  profile,
  userEmail,
  onLogout,
  channelSidebarOpen,
  onToggleChannelSidebar,
  onMobileBack,
  workspace,
  onOpenResource,
  onBackToSearch,
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [ratingPending, setRatingPending] = useState({});
  const [ratingErrors, setRatingErrors] = useState({});
  const [openedResourceId, setOpenedResourceId] = useState(null);
  const searchControllerRef = useRef(null);
  const ratingControllersRef = useRef(new Map());
  const requestGuardRef = useRef(createServerRequestGuard(serverId));

  useEffect(() => {
    const requestGuard = requestGuardRef.current;
    const ratingControllers = ratingControllersRef.current;
    requestGuard.switchServer(serverId);
    return () => {
      requestGuard.invalidate();
      searchControllerRef.current?.abort();
      ratingControllers.forEach((controller) => controller.abort());
      ratingControllers.clear();
    };
  }, [serverId]);

  const handleSearch = async (event) => {
    event.preventDefault();
    const normalizedQuery = query.trim();
    if (!normalizedQuery || !serverId || loading) return;

    searchControllerRef.current?.abort();
    const controller = new AbortController();
    searchControllerRef.current = controller;
    const token = requestGuardRef.current.begin(serverId);

    setLoading(true);
    setHasSearched(true);
    setSearchError('');
    setResults([]);
    ratingControllersRef.current.forEach((ratingController) => ratingController.abort());
    ratingControllersRef.current.clear();
    setRatingPending({});
    setRatingErrors({});

    try {
      const response = await searchServerResources(
        apiRequest,
        serverId,
        normalizedQuery,
        { signal: controller.signal },
      );
      if (requestGuardRef.current.isCurrent(token, serverId)) {
        setResults(Array.isArray(response?.results) ? response.results : []);
      }
    } catch (error) {
      if (
        error?.name !== 'AbortError'
        && requestGuardRef.current.isCurrent(token, serverId)
      ) {
        setSearchError(searchErrorMessage(error));
      }
    } finally {
      if (requestGuardRef.current.isCurrent(token, serverId)) {
        setLoading(false);
      }
    }
  };

  const mutateRating = async (resourceId, rating) => {
    if (ratingPending[resourceId]) return;
    const controller = new AbortController();
    ratingControllersRef.current.get(resourceId)?.abort();
    ratingControllersRef.current.set(resourceId, controller);
    const token = requestGuardRef.current.capture();

    setRatingPending((current) => ({ ...current, [resourceId]: true }));
    setRatingErrors((current) => ({ ...current, [resourceId]: '' }));

    try {
      const summary = rating == null
        ? await deleteResourceRating(apiRequest, resourceId, { signal: controller.signal })
        : await putResourceRating(apiRequest, resourceId, rating, { signal: controller.signal });
      if (requestGuardRef.current.isCurrent(token, serverId)) {
        setResults((current) => replaceRatingSummary(current, resourceId, summary));
      }
    } catch (error) {
      if (
        error?.name !== 'AbortError'
        && requestGuardRef.current.isCurrent(token, serverId)
      ) {
        setRatingErrors((current) => ({
          ...current,
          [resourceId]: ratingErrorMessage(error),
        }));
      }
    } finally {
      ratingControllersRef.current.delete(resourceId);
      if (requestGuardRef.current.isCurrent(token, serverId)) {
        setRatingPending((current) => ({ ...current, [resourceId]: false }));
      }
    }
  };

  const handleOpenResource = (resourceId) => {
    setOpenedResourceId(resourceId);
    onOpenResource();
  };

  const openedResource = results.find(
    (resource) => resource.resource_id === openedResourceId,
  );

  return (
    <main className="main-panel advanced-search-panel">
      <header className="main-panel__topbar">
        <div className="main-panel__topbar-left">
          <button className="main-panel__mobile-back" onClick={onMobileBack} aria-label="Back to channels" title="Back to channels">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button className="main-panel__sidebar-toggle" onClick={onToggleChannelSidebar} aria-label={channelSidebarOpen ? 'Hide channels' : 'Show channels'} title={channelSidebarOpen ? 'Hide channels' : 'Show channels'}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
          <svg className="main-panel__channel-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" />
          </svg>
          <h2 className="main-panel__channel-name">
            {workspace === 'resource' ? 'Resource' : 'Advanced Search'}
          </h2>
          <span className="main-panel__server-badge">{serverName}</span>
        </div>
        <div className="main-panel__topbar-right">
          <button className="main-panel__profile-btn" onClick={() => navigate('/profile')} title="Profile Settings">
            {profile?.avatar_url ? (
              <img src={profile.avatar_url} alt="Avatar" className="main-panel__avatar" />
            ) : (
              <div className="main-panel__avatar-placeholder">
                {profile?.username?.[0]?.toUpperCase() || '?'}
              </div>
            )}
            <span className="main-panel__username">{profile?.username || userEmail}</span>
          </button>
          <button className="btn btn-secondary main-panel__logout" onClick={onLogout}>
            <span className="main-panel__logout-label">Log out</span>
          </button>
        </div>
      </header>

      {workspace === 'resource' && openedResource ? (
        <div className="advanced-search-panel__body">
          <ResourceAccessPanel
            key={openedResource.resource_id}
            resource={openedResource}
            ratingPending={Boolean(ratingPending[openedResource.resource_id])}
            ratingError={ratingErrors[openedResource.resource_id] || ''}
            onRate={mutateRating}
            onClearRating={(resourceId) => mutateRating(resourceId, null)}
            onBack={onBackToSearch}
          />
        </div>
      ) : (
      <div className="advanced-search-panel__body">
        <section className="advanced-search-panel__intro">
          <div>
            <h1>Advanced Search</h1>
            <p>Search documents available across {serverName || 'this server'}.</p>
          </div>
          <form className="advanced-search-form" onSubmit={handleSearch}>
            <label htmlFor="advanced-search-query" className="advanced-search-form__label">
              Topic, phrase, or natural-language question
            </label>
            <div className="advanced-search-form__row">
              <input
                id="advanced-search-query"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="How does HNSW find nearest neighbours?"
                maxLength={1000}
                disabled={loading}
              />
              <button type="submit" disabled={loading || !query.trim()}>
                {loading ? 'Searching…' : 'Search'}
              </button>
            </div>
          </form>
          <p className="advanced-search-panel__score-note">
            Results are ordered by semantic relevance.
          </p>
        </section>

        <section className="advanced-search-results" aria-live="polite">
          {loading && (
            <div className="advanced-search-state">
              <div className="advanced-search-spinner" aria-hidden="true" />
              <p>Searching server resources…</p>
            </div>
          )}
          {!loading && searchError && (
            <div className="advanced-search-state advanced-search-state--error" role="alert">
              <p>{searchError}</p>
              <button type="button" onClick={handleSearch}>Try again</button>
            </div>
          )}
          {!loading && !searchError && hasSearched && results.length === 0 && (
            <div className="advanced-search-state">
              <p>No searchable resources are available for this server.</p>
            </div>
          )}
          {!loading && !searchError && results.length > 0 && (
            <>
              <div className="advanced-search-results__heading">
                <h2>Closest matching resources</h2>
                <span>{results.length} result{results.length === 1 ? '' : 's'}</span>
              </div>
              <div className="advanced-search-results__list">
                {results.map((resource, index) => (
                  <ResourceSearchCard
                    key={resource.resource_id}
                    resource={resource}
                    isBestMatch={isBestMatchResult(index)}
                    onOpen={handleOpenResource}
                  />
                ))}
              </div>
            </>
          )}
          {!loading && !searchError && !hasSearched && (
            <div className="advanced-search-state">
              <p>Enter a topic or question to find the closest documents in this server.</p>
            </div>
          )}
        </section>
      </div>
      )}
    </main>
  );
}
