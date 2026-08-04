import CreateForm from "../components/create/CreateForm";

export default function Create() {
  return (
    <div className="flex flex-1 flex-col items-center py-8">
      <div className="w-full max-w-[1100px] animate-fade-in">
        <CreateForm />
      </div>
    </div>
  );
}
