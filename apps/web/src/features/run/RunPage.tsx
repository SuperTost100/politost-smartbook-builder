import { useParams } from 'react-router-dom';
import { RunView } from './RunView';

export default function RunPage() {
  const { id } = useParams();
  return (
    <div className="ui-page ui-page--narrow">
      <h1 className="ui-screen-title">Run</h1>
      <RunView projectId={id!} />
    </div>
  );
}
