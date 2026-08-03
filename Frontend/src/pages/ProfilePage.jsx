import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/AuthContext';

export default function ProfilePage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const user = session?.user;

  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const [profile, setProfile] = useState({
    username: '',
    full_name: '',
    bio: '',
    avatar_url: '',
  });

  const [avatarFile, setAvatarFile] = useState(null);
  const [avatarPreview, setAvatarPreview] = useState(null);

  useEffect(() => {
    if (!user) return;

    async function loadProfile() {
      try {
        setLoading(true);
        const { data, error } = await supabase
          .from('profiles')
          .select('username, full_name, bio, avatar_url')
          .eq('id', user.id)
          .single();

        if (error && error.code !== 'PGRST116') throw error;

        if (data) {
          setProfile({
            username: data.username || '',
            full_name: data.full_name || '',
            bio: data.bio || '',
            avatar_url: data.avatar_url || '',
          });
          if (data.avatar_url) {
            setAvatarPreview(data.avatar_url);
          }
        } else {
          // If profile doesn't exist, use defaults
          setProfile(prev => ({
            ...prev,
            username: user.email?.split('@')[0] || `user-${user.id.slice(0, 8)}`,
          }));
        }
      } catch (err) {
        console.error('Error loading profile:', err);
        setError('Failed to load profile');
      } finally {
        setLoading(false);
      }
    }

    loadProfile();
  }, [user]);

  const handleAvatarChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setAvatarFile(file);
      setAvatarPreview(URL.createObjectURL(file));
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!user) return;

    setUpdating(true);
    setError(null);
    setSuccess(false);

    try {
      let finalAvatarUrl = profile.avatar_url;

      // 1. Upload avatar if changed
      if (avatarFile) {
        const fileExt = avatarFile.name.split('.').pop();
        const fileName = `${user.id}-${Math.random()}.${fileExt}`;
        const filePath = `${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(filePath, avatarFile);

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from('avatars')
          .getPublicUrl(filePath);

        finalAvatarUrl = publicUrl;
      }

      // 2. Update profile
      const { error: updateError } = await supabase
        .from('profiles')
        .upsert({
          id: user.id,
          email: user.email,
          username: profile.username,
          full_name: profile.full_name,
          bio: profile.bio,
          avatar_url: finalAvatarUrl,
          updated_at: new Date().toISOString(),
        });

      if (updateError) throw updateError;

      setProfile(prev => ({ ...prev, avatar_url: finalAvatarUrl }));
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      console.error('Error updating profile:', err);
      setError(err.message || 'Failed to update profile');
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return (
      <div className="auth-layout">
        <div className="auth-card" style={{ textAlign: 'center' }}>
          <p>Loading profile...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-layout">
      <div className="auth-card" style={{ maxWidth: '440px' }}>
        <button
          onClick={() => navigate('/dashboard')}
          className="btn btn-secondary"
          style={{ width: 'auto', padding: '6px 12px', fontSize: '12px', marginBottom: '16px', borderRadius: 'var(--radius-xs)' }}
        >
          ← Back
        </button>

        <header className="auth-header" style={{ marginBottom: '24px' }}>
          <h1 className="auth-title">Profile Settings</h1>
          <p className="auth-subtitle">Update your public identity on StudyCord</p>
        </header>

        <form onSubmit={handleSave}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px', padding: '16px', backgroundColor: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
            <div
              style={{
                width: '56px',
                height: '56px',
                borderRadius: '50%',
                backgroundColor: 'var(--bg-darkest)',
                overflow: 'hidden',
                border: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '20px',
                fontWeight: 500,
                color: 'var(--text-primary)',
                flexShrink: 0,
              }}
            >
              {avatarPreview ? (
                <img src={avatarPreview} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                profile.username?.[0]?.toUpperCase() || '?'
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)', marginBottom: '6px' }}>
                {profile.username || 'Username'}
              </div>
              <label className="btn btn-secondary" style={{ width: 'auto', padding: '6px 12px', fontSize: '12px', cursor: 'pointer', borderRadius: 'var(--radius-xs)' }}>
                Change Avatar
                <input type="file" accept="image/*" onChange={handleAvatarChange} style={{ display: 'none' }} />
              </label>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="username">Username</label>
            <input
              id="username"
              className="form-input"
              type="text"
              value={profile.username}
              onChange={(e) => setProfile({ ...profile, username: e.target.value })}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="full_name">Full Name</label>
            <input
              id="full_name"
              className="form-input"
              type="text"
              value={profile.full_name}
              onChange={(e) => setProfile({ ...profile, full_name: e.target.value })}
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="bio">Bio</label>
            <textarea
              id="bio"
              className="form-input"
              rows="3"
              style={{ resize: 'none' }}
              value={profile.bio}
              onChange={(e) => setProfile({ ...profile, bio: e.target.value })}
              placeholder="Tell us about your studies..."
            />
          </div>

          {error && <div className="error-message">{error}</div>}
          {success && <div className="success-message">Profile updated successfully!</div>}

          <button type="submit" className="btn btn-primary" disabled={updating}>
            {updating ? 'Saving...' : 'Save Changes'}
          </button>
        </form>
      </div>
    </div>
  );
}
